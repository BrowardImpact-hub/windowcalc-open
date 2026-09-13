# WindowCalc Mobile Product Direction

## Core Position

WindowCalc mobile should stay as one codebase with two shaped experiences:

1. Rep phone experience
2. Hub tablet experience

That lets us share auth, offline storage, sync, pricing behavior, and release processes while still giving reps and leadership the right UX for their device.

## Experience Split

### Rep Phone

Primary users:
- field reps
- installers doing capture
- fast-moving sales users

Primary jobs:
- create quote drafts offline
- add openings quickly
- attach photos and notes
- resume the last job fast
- sync safely when service returns

### Hub Tablet

Primary users:
- managers
- owners
- sysops
- executives in motion

Primary jobs:
- review quote flow
- monitor sync health
- handle approvals
- watch pipeline and rep activity
- eventually run live chat and report drill-downs

## What Was Added In This Pass

- Tablet-aware hub shell foundation
- Role-aware navigation split
- Shared local draft and sync core for both experiences
- Explicit web low-data `Lite` mode for browser-based field use

## Next Build Order

1. Tablet split-view approvals and live chat
2. Attachment and photo queue for rep flow
3. Route pack / appointment prefetch
4. Offline compliance packs
5. Report and pipeline tablet views
6. App store polish, permissions, icons, splash, bundle identifiers

## Tomorrow SDK / Store Work

When the SDK tools are installed, the next practical tasks are:

1. Run the app in Expo on phone and tablet simulators
2. Verify navigation and draft persistence on iPhone and Android
3. Add proper icons, splash assets, bundle IDs, package names
4. Configure build profiles for TestFlight and Play internal testing
5. Start camera, attachment, and permission flows on real devices
