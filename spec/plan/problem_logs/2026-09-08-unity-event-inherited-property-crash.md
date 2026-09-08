# Unity event lookup crashes on inherited property names

- Date: 2026-09-08
- Area: Unity lifecycle recognition

## Evidence
Revisor could not analyze the source-base-color shader change for MakaiNui.
Running the static PR analysis against the isolated four-file reland reproduced
`TypeError: Cannot read properties of undefined (reading 'some')` at
`isSupportedEventSignature`, lifecycle.js:75, called from
`resolveUnityLifecycleFunctions`, lifecycle.js:141.

## Cause and fix
`EVENTS[fn.name]` also resolves inherited Object properties, such as `constructor`.
They are truthy but have no `parameterLists`, so the signature check dereferenced
`undefined`. Every lookup now goes through an `eventRule` helper that requires
own-property membership, so unregistered names cannot become Unity callbacks.
The helper covers both `resolveUnityLifecycleFunctions` and the exported
`unityLifecyclePhase`, which had the same latent lookup.

## Verification
The registered tests cover the crash directly: one case feeds constructor,
toString, hasOwnProperty and __proto__ alongside a valid Update callback and
expects only Update to match; another asserts `unityLifecyclePhase` returns
undefined for those names. No Unity startup was used to investigate this failure.
