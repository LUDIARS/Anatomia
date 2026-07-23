#pragma once
// Anatomia trace-recording library (C++, header-only) — the CANONICAL runtime.
//
// Emits the JSONL wire protocol dynamic/protocol.ts defines, one event per line,
// to the file named by $ANATOMIA_TRACE_FILE. Recording is compiled in only when
// ANATOMIA_MEASUREMENT_BUILD is defined, and even then is a runtime no-op while
// the env var is unset — a measurement binary always runs clean.
//
// Usage (see docs/trace-operations.md and spec/feature/trace-recording.md):
//   #define ANATOMIA_MEASUREMENT_BUILD   // or -DANATOMIA_MEASUREMENT_BUILD
//   #include "anatomia_trace.hpp"
//   ANATOMIA_FRAME_BEGIN(frameIndex);    // main loop, top
//   ANATOMIA_ZONE("UpdateGame", "abc123…anchor");  // RAII, per zone
//   ANATOMIA_FRAME_END(frameIndex);      // main loop, bottom
//
// Env:
//   ANATOMIA_TRACE_FILE   output path (unset → recording off)
//   ANATOMIA_TRACE_FLUSH  "1" → flush after every line (near-live tailing;
//                         slower — leave unset for buffered writes)
//
// `anatomia trace plan` embeds this exact file as anatomia_zones.h; the copy in
// runtime/cpp/ is the source of truth (a test pins generateCppHeader to it).

#ifdef ANATOMIA_MEASUREMENT_BUILD
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <chrono>
#include <mutex>

namespace anatomia {

  // Process-wide JSONL sink. Opened lazily from $ANATOMIA_TRACE_FILE; recording
  // is a no-op when the env var is unset (a measurement build still runs clean).
  class Recorder {
  public:
    static Recorder& instance() { static Recorder r; return r; }

    bool enabled() const { return file_ != nullptr; }

    std::uint64_t nowUs() const {
      using namespace std::chrono;
      return static_cast<std::uint64_t>(
        duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count());
    }

    void frameBegin(std::uint64_t id, std::uint64_t ts) {
      writeEvent("frame_begin", id, ts);
    }
    void frameEnd(std::uint64_t id, std::uint64_t ts) {
      writeEvent("frame_end", id, ts);
    }
    void zoneEnter(const char* anchorId, std::uint64_t ts) {
      writeZone("zone_enter", anchorId, ts);
    }
    void zoneExit(const char* anchorId, std::uint64_t ts) {
      writeZone("zone_exit", anchorId, ts);
    }

  private:
    std::FILE* file_ = nullptr;
    bool flushEachLine_ = false;
    std::mutex mu_;

    Recorder() {
      const char* path = std::getenv("ANATOMIA_TRACE_FILE");
      if (path && path[0]) file_ = std::fopen(path, "wb");
      const char* flush = std::getenv("ANATOMIA_TRACE_FLUSH");
      flushEachLine_ = (flush && flush[0] == '1');
    }
    ~Recorder() { if (file_) std::fclose(file_); }
    Recorder(const Recorder&) = delete;
    Recorder& operator=(const Recorder&) = delete;

    void writeEvent(const char* type, std::uint64_t frameId, std::uint64_t ts) {
      if (!file_) return;
      std::lock_guard<std::mutex> lk(mu_);
      std::fprintf(file_, "{\"type\":\"%s\",\"frameId\":%llu,\"timestampUs\":%llu}\n",
                   type, (unsigned long long)frameId, (unsigned long long)ts);
      if (flushEachLine_) std::fflush(file_);
    }
    void writeZone(const char* type, const char* anchorId, std::uint64_t ts) {
      if (!file_) return;
      std::lock_guard<std::mutex> lk(mu_);
      std::fprintf(file_, "{\"type\":\"%s\",\"anchorId\":\"%s\",\"timestampUs\":%llu}\n",
                   type, anchorId, (unsigned long long)ts);
      if (flushEachLine_) std::fflush(file_);
    }
  };

  // RAII scope marker: emits zone_enter on construction, zone_exit on destruction.
  struct Zone {
    const char* anchorId;
    explicit Zone(const char* /*name*/, const char* anchorId_) : anchorId(anchorId_) {
      Recorder::instance().zoneEnter(anchorId, Recorder::instance().nowUs());
    }
    ~Zone() {
      Recorder::instance().zoneExit(anchorId, Recorder::instance().nowUs());
    }
  };

} // namespace anatomia

#define ANATOMIA_CONCAT_(a, b) a##b
#define ANATOMIA_CONCAT(a, b) ANATOMIA_CONCAT_(a, b)
#define ANATOMIA_ZONE(name, anchorId) \
  ::anatomia::Zone ANATOMIA_CONCAT(_anatomia_zone_, __LINE__)(name, anchorId)
// Frame markers go in the game's main loop (Anatomia cannot auto-locate it):
//   ANATOMIA_FRAME_BEGIN(frameIndex); ... ANATOMIA_FRAME_END(frameIndex);
#define ANATOMIA_FRAME_BEGIN(id) \
  ::anatomia::Recorder::instance().frameBegin((id), ::anatomia::Recorder::instance().nowUs())
#define ANATOMIA_FRAME_END(id) \
  ::anatomia::Recorder::instance().frameEnd((id), ::anatomia::Recorder::instance().nowUs())
#else
#define ANATOMIA_ZONE(name, anchorId) /* no-op */
#define ANATOMIA_FRAME_BEGIN(id) /* no-op */
#define ANATOMIA_FRAME_END(id) /* no-op */
#endif
