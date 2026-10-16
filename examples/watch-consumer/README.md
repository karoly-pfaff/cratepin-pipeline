# Watch lifecycle prototype

This repository-only experiment evaluates an optional host lifecycle. It is not a published
`cratepin watch` command or bundler plugin. Use the normal CLI prebuild in production.
This prototype watches only the default config/lock inputs and has no shared global cache.

`RebuildQueue` takes `{ build, debounceMs }` and exposes `request()`, `snapshot` and asynchronous
`close()`. `watchProjectInputs({ projectRoot, queue })` watches the default config/lock in that
directory and exposes asynchronous `close()`. Close the watcher before releasing its queue;
its `close()` does both and returns any watcher/build failure. Close the queue if watcher setup
throws. Watcher events never run author push.

`offlineRebuilder({ projectRoot, cliFile, nodeOptions })` supplies the safe build callback.
`cliFile` must explicitly identify the trusted public CLI bin declared by the installed
package; the prototype does no package discovery or deep import. It invokes fixed offline
build/verify arguments directly with Node, inherits only PATH/SystemRoot and awaits child exit
on cancellation. Do not pass an npm shim or shell command as `cliFile`; do not copy a source
entry path from tests into a consuming application. `nodeOptions` is optional trusted host
configuration, never project/user content.

Compose these three pieces in the host that owns teardown, explicitly request the initial
build, inspect `queue.snapshot.lastFailure`, and await watcher close on teardown. Keep push
outside this lifecycle. The checked tests demonstrate composition with the generic source CLI;
the separate package gate exercises the installed package. An installed-package watcher/plugin
needs additional lifecycle, resolution and platform evidence before becoming supported.
