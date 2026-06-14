# Mini Mechanic Spec

## Skill

A `Skill` holds a list of `Action`s. The `runtime.cpp` Runtime ticks the skill
each frame and emits the produced action.

## Action

An `Action` carries a kind and a magnitude. Actions are appended to the skill's
action list.
