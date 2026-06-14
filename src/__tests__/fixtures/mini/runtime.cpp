// Mini fixture runtime: emits actions from a skill each tick.
#include "skill.h"

class Runtime {
public:
    void tick(float dt, Skill& skill) {
        elapsed_ += dt;
        Action a{0, dt};
        skill.add(a);
        emit(a);
    }
    void emit(const Action& a) {
        last_kind_ = a.kind;
    }
    int last() const { return last_kind_; }
private:
    float elapsed_ = 0.0f;
    int last_kind_ = -1;
};

int run_once(Runtime& rt, Skill& skill) {
    rt.tick(0.016f, skill);
    return rt.last();
}
