// Anatomia trace-recording library (C#, single file) — the CANONICAL runtime.
//
// Emits the JSONL wire protocol dynamic/protocol.ts defines, one event per line,
// to the file named by $ANATOMIA_TRACE_FILE. Recording is compiled in only when
// ANATOMIA_MEASUREMENT_BUILD is defined (Unity: add it to
// Project Settings → Player → Scripting Define Symbols), and even then is a
// runtime no-op while the env var is unset — a measurement build always runs clean.
//
// Targets .NET Standard 2.0 (works in Unity Mono/IL2CPP and plain .NET).
//
// Usage (see docs/trace-operations.md and spec/feature/trace-recording.md):
//   Anatomia.Trace.FrameBegin(frameIndex);            // main loop, top
//   using (new Anatomia.Zone("Update", "abc123…")) {  // per zone (or `using var`)
//     ...
//   }
//   Anatomia.Trace.FrameEnd(frameIndex);              // main loop, bottom
//
// Env:
//   ANATOMIA_TRACE_FILE   output path (unset → recording off)
//   ANATOMIA_TRACE_FLUSH  "1" → flush after every line (near-live tailing;
//                         slower — leave unset for buffered writes)
//
// `anatomia trace plan --lang csharp` embeds this exact file; the copy in
// runtime/csharp/ is the source of truth (a test pins generateCSharpStub to it).

#if ANATOMIA_MEASUREMENT_BUILD
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace Anatomia
{
    /// <summary>
    /// Process-wide JSONL trace recorder. Thread-safe; opened lazily from
    /// $ANATOMIA_TRACE_FILE, no-op while the env var is unset.
    /// </summary>
    public static class Trace
    {
        private static readonly object Gate = new object();
        private static StreamWriter _writer;
        private static bool _flushEachLine;
        private static bool _initialized;
        private static readonly Stopwatch Clock = Stopwatch.StartNew();

        /// <summary>Monotonic timestamp in microseconds (protocol timestampUs).</summary>
        public static ulong NowUs()
        {
            return (ulong)(Clock.ElapsedTicks * 1_000_000L / Stopwatch.Frequency);
        }

        public static void FrameBegin(ulong frameId) { WriteFrame("frame_begin", frameId, NowUs()); }
        public static void FrameEnd(ulong frameId) { WriteFrame("frame_end", frameId, NowUs()); }
        public static void ZoneEnter(string anchorId) { WriteZone("zone_enter", anchorId, NowUs()); }
        public static void ZoneExit(string anchorId) { WriteZone("zone_exit", anchorId, NowUs()); }

        private static void EnsureInitialized()
        {
            if (_initialized) return;
            _initialized = true;
            string path = Environment.GetEnvironmentVariable("ANATOMIA_TRACE_FILE");
            if (string.IsNullOrEmpty(path)) return;
            try
            {
                // Buffered writer; AutoFlush only in near-live mode.
                _flushEachLine = Environment.GetEnvironmentVariable("ANATOMIA_TRACE_FLUSH") == "1";
                // BOM-less UTF-8: the C++ recorder writes none, and a BOM would
                // lean on the parser's trim() to survive.
                _writer = new StreamWriter(path, append: false, new UTF8Encoding(false)) { AutoFlush = _flushEachLine };
                AppDomain.CurrentDomain.ProcessExit += (_, __) => { lock (Gate) { _writer?.Flush(); _writer?.Dispose(); _writer = null; } };
            }
            catch
            {
                _writer = null; // unwritable path → recording stays off (never throw into the game)
            }
        }

        private static void WriteFrame(string type, ulong frameId, ulong ts)
        {
            lock (Gate)
            {
                EnsureInitialized();
                if (_writer == null) return;
                _writer.Write("{\"type\":\"");
                _writer.Write(type);
                _writer.Write("\",\"frameId\":");
                _writer.Write(frameId);
                _writer.Write(",\"timestampUs\":");
                _writer.Write(ts);
                _writer.Write("}\n");
            }
        }

        private static void WriteZone(string type, string anchorId, ulong ts)
        {
            lock (Gate)
            {
                EnsureInitialized();
                if (_writer == null) return;
                _writer.Write("{\"type\":\"");
                _writer.Write(type);
                _writer.Write("\",\"anchorId\":\"");
                _writer.Write(EscapeJson(anchorId));
                _writer.Write("\",\"timestampUs\":");
                _writer.Write(ts);
                _writer.Write("}\n");
            }
        }

        /// <summary>Minimal JSON string escaping (anchor ids are hex-like, but stay safe).</summary>
        private static string EscapeJson(string s)
        {
            if (s == null) return "";
            if (s.IndexOf('"') < 0 && s.IndexOf('\\') < 0) return s;
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }
    }

    /// <summary>
    /// Scoped zone marker: emits zone_enter on construction, zone_exit on Dispose.
    /// Use with a using statement: <c>using (new Anatomia.Zone("name", "anchorId")) { … }</c>.
    /// The anchorId is baked in at injection time (trace plan), so ingest needs no
    /// name→anchor resolution; the name parameter is for human readability only.
    /// </summary>
    public struct Zone : IDisposable
    {
        private readonly string _anchorId;

        public Zone(string name, string anchorId)
        {
            _anchorId = anchorId;
            Trace.ZoneEnter(anchorId);
        }

        public void Dispose()
        {
            Trace.ZoneExit(_anchorId);
        }
    }
}
#else
namespace Anatomia
{
    /// <summary>No-op trace API for non-measurement builds.</summary>
    public static class Trace
    {
        public static ulong NowUs() { return 0; }
        public static void FrameBegin(ulong frameId) { }
        public static void FrameEnd(ulong frameId) { }
        public static void ZoneEnter(string anchorId) { }
        public static void ZoneExit(string anchorId) { }
    }

    /// <summary>No-op Zone for non-measurement builds.</summary>
    public struct Zone : System.IDisposable
    {
        public Zone(string name, string anchorId) { }
        public void Dispose() { }
    }
}
#endif
