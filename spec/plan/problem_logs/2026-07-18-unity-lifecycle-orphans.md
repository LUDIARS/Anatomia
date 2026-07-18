# Unity lifecycle callbacks reported as orphan functions

- Date: 2026-07-18
- Status: fixed in working tree
- Area: static review / graph visualization
- Severity: repeated false-positive review findings in Unity projects

## Summary

Anatomia treated Unity-invoked `MonoBehaviour` event functions such as `Awake`,
`Update`, and `OnDestroy` as ordinary functions. Since Unity calls these methods
externally and no static caller exists in project source, they were repeatedly
reported as orphan functions.

## Evidence

The orphan review in `src/review/build.ts` classified every function with
`fanIn === 0` (except `main`) as an orphan. Unity's documented execution-order
callbacks therefore had no representation of their engine-owned entrypoint.

## Regression Context

This is a recurring framework-analysis gap rather than a newly introduced code
regression. Static call-graph tests did not include engine-owned lifecycle entrypoints.

## Cause

The review had no project/framework profile and no Unity lifecycle map. Method
names alone are insufficient because an ordinary C# project can legitimately
contain methods named `Update` or `Start`.

## Fix Requirements

- Enable Unity analysis only when canonical Unity project markers are present.
- Resolve lifecycle names only on direct or indirect `MonoBehaviour` subclasses.
- Exclude resolved lifecycle callbacks from orphan findings without inventing call edges.
- Label lifecycle callbacks in graph metadata.
- Provide function/class graph views and aggregate member edges in class view.
- Default C++/C#/Java to class view and TypeScript/Go to function view.

## Verification

- Unit tests cover Unity project gating, inheritance, lifecycle names, and non-Unity C#.
- Projection tests cover class-edge aggregation while preserving the function graph.
- Review regression tests verify lifecycle callbacks are not listed as orphans.

## Follow-up

Keep the event map aligned with the pinned Unity 2021.3 documentation when the
supported Unity baseline changes.
