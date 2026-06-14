// Mini fixture mechanic: a tiny Skill -> Action chain for e2e wiring tests.
#pragma once
#include <vector>

struct Action {
    int kind;
    float magnitude;
};

class Skill {
public:
    void add(Action a) { actions_.push_back(a); }
    bool replace(const Action& a) {
        for (auto& e : actions_) {
            if (e.kind == a.kind) { e = a; return true; }
        }
        actions_.push_back(a);
        return false;
    }
    int count() const { return static_cast<int>(actions_.size()); }
private:
    std::vector<Action> actions_;
};
