# Changelog

Notable changes, newest first. Dates are the day the work landed on `master`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## 3.0.0 — 2026-09-23

The first release published to npm, and the reason for the major number: two of the changes
below break a project upgrading from 2.0.0 by hand.

### Changed — breaking

- **The package is called `image-drop-upload`.** `drag-and-drop-preview-images-module` said
  what it was and nothing about what it is for, and the word "module" carried no meaning at
  all. The repository keeps its name; only the package and the import specifiers change.
- **Node 20 or newer.** See below.
- **busboy is no longer installed with the package.** See below.

### Added

- **A cap on what one client may upload**, counted across requests rather than within one.
  `limits.perClient` takes files, bytes and a window, keyed on the session where there is one
  and the remote address otherwise.
- **Storage is swappable, and S3 is included.** `storage` takes a backend; leave it out and
  files go to `root` on local disk as before. The S3 backend speaks the API directly —
  request signing is Signature Version 4 over `node:crypto`, so no SDK is added — and works
  with anything S3-compatible through `endpoint`.
- **A speed limit for uploads.** `limits.maxBytesPerSecond` makes the server read that
  slowly, which is the only place the question can be answered: a browser gives JavaScript
  no control over how fast it sends a request body.
- **Reordering the queue.** Drag a tile, hold its grip and drag on a touch screen, or focus
  one and press Alt with an arrow. `move(id, index)` does the same from code. On by default;
  `reorder: false` turns the interaction off and leaves the method.
- **Progress for each file**, not only for the batch — a thin bar across each thumbnail,
  shown while that file is on the wire.
- **Pasting and the camera.** Ctrl+V a screenshot into the widget or the whole page; a "Take
  a photo" button that opens the camera on a phone, wired to a second input so the main one
  keeps `multiple`. Both on by default.
- **Resuming a mass upload.** Files travel one per request, so an interruption costs the one
  in flight rather than the whole batch. `filesPerRequest` sets the grouping.
- **Retrying a failed upload**, automatically with a growing wait or on a button, and only
  for failures that are about the connection rather than about the file.
- **Compression before sending** — resize, re-encode at a chosen quality, or drop metadata
  without touching a pixel. On the page, so the bytes saved never travel.
- **Filing uploads under a session.** `sessions.identify(req)` reads whatever the host uses
  to tell visitors apart; each gets a folder and every answer names the owner.
- **Malware screening**, as a VirusTotal lookup by hash or any scanner through a hook. Only
  the hash leaves the server.
- **A dimension limit on the server.** A 30 KB PNG declaring 40000×40000 is refused while it
  is still streaming; the dimensions are read from the header without decoding anything.
- **The S3 backend is tested against a real server.** Eight tests talk to MinIO rather than
  to a stubbed `fetch`: a path signed one way and sent another agrees with a test that checks
  it the same wrong way, and only a server says 403. CI starts one on every push; on a machine
  without one the tests skip themselves. They were checked by breaking the path encoding on
  purpose, which failed two of them.

### Changed

- **The multipart parser is no longer installed with the package.** `busboy` is an
  optional peer dependency now, so a page that uses the widget against a backend written
  in something else — the common case for a browser widget — stops installing a Node
  parser it never loads. `npm install busboy` alongside the package is what the server
  half needs, and the README says so where the server is introduced.
- `createUploadHandler()` asks for busboy when it is built rather than at the first
  upload, and says what to install when it is missing. Measured before this: the app
  started, looked healthy, and answered the first real upload with a plain
  `500 {"error":"Internal server error"}`, with `Cannot find module 'busboy'` reaching
  the host only through `onWarning` and only after somebody's upload had already failed.
  Importing `/server` still needs nothing, and neither does `UploadService` on its own.


- **Node 20 is the floor**, where the package claimed 18. The library itself needs nothing
  newer, but the tests do — `File` and `zlib.crc32` both arrived after 18 — so the Node 18
  job in CI had been red since the day the workflow landed, and the suite had in truth never
  run there. Declaring 20 says what is actually checked. The matrix is now 20, 22 and 24,
  and all three were run green before this went in.

### Fixed

- **Two uploads of one name at once left one file in the bucket and told both they had been
  stored.** The S3 path asked `exists()` and then wrote, which is two questions with a gap in
  the middle; the disk path has always claimed its name with `O_EXCL`. Measured: four
  requests sent together under one name left one object and three photographs gone, every
  answer a 200. The write now carries `If-None-Match: *`, so the service answers 412 and the
  next name is tried — the same guarantee, from the service rather than from hope.
  `conditionalWrites: false` turns it off for a service that rejects the header.
- The answer said nothing about where a file had gone. `key`, `path` and `etag` reach the
  client for a storage backend, as the README had been claiming all along, and `publicUrl`
  is no longer worked out and thrown away. A local `root` still reports none of them: that
  answer would be a path on your filesystem.
- `sessions` with `scope: 'label'` gave the bucket a folder per session anyway, although it
  leaves the disk flat and the README promises "one flat folder". The folder now comes from
  the same value on both paths. With it goes a smaller hole: under `label` a session id was
  not checked for being a single segment, so an id like `a/b` — which `scope: 'directory'`
  refuses outright — quietly made nested keys.
- A backend meant the session's directory was created on local disk and then left there
  empty, one per visitor, on a disk none of the files landed on.
- Both READMEs described `fit: 'cover'` as filling the box without saying it overflows it. A
  1000×4000 picture in an 800×600 box comes out 800×3200, deliberately — nothing is cropped.
- A file refused because the per-client budget was spent was treated as refused for good:
  the Retry button hid itself and `retry()` passed it over, so the only way forward was to
  empty the queue and choose the same files again — although the budget fills up when its
  window passes. `worthTryingAgain` is the wider question the button now asks; the automatic
  retry still does not repeat it, since the window is a minute by default and the schedule
  here is seconds.
- A batch refused only because the per-client budget ran out answered 400 when the budget
  ran out while the body was being read, and 429 when it ran out before. The same refusal,
  two different answers, measured at one request in sixty of eight sent at once — and 400
  says the request was malformed and carries no `Retry-After`, so nothing told the client
  when to come back. Both paths answer 429 with it now.
- Both READMEs said uploads were one request for the whole queue and that there was no
  chunking. That stopped being true when `filesPerRequest` and resuming landed: a dropped
  connection picks up at the file it stopped on. There is still no chunking inside a file,
  which is what the line says now.
- An upload the client abandoned mid-part left its temporary file behind for ever, because
  busboy goes silent when a request dies and nothing settled the write.
- An error handler that threw took the response with it, leaving the socket open until the
  client gave up rather than answering 500.
- A batch the server refused in full showed one generic message on every tile instead of the
  per-file reasons the server had sent, and `Error {status}` reached the screen with the
  placeholder still in it.
- Pressing Upload while a batch was still being decoded and shrunk sent the original bytes.
- Cancelling an upload marked every file as failed, which left the queue unsendable.
- The header buffer was not capped: a single chunk can be a whole file.
- `maxFiles` and `maxRequestSize` stopped capping anything recognisable once the widget began
  sending a file per request: they limit one request, and each request now held one file.
  Measured — limits of three files and 20 KB let ten files totalling 80 KB through. The
  README now says plainly what they limit, and `perClient` is what caps a person.
- `move()` reordered the queue during an upload although the drag and the keyboard both
  refuse then, so the order on screen could drift from the order files were going out in.
- A line in the storage path that could never run.
- The per-client cap did not hold when requests arrived at once — eight sent together all
  passed a limit of three, because each checked before any had recorded anything. The place
  is now claimed at the moment of asking, and given back by a file that does not land.
- The tally kept every client it had ever seen: pruning only happened for a key that came
  back, so a thousand one-off visitors left a thousand entries for good.
- The ES bundle was shipped with its newlines: Vite shortens identifiers in library mode but
  leaves the ES output laid out over its lines, which cost six kilobytes of gzip to anyone
  loading it from a script tag rather than through a bundler. 22.1 KB gzipped, now 16.0.
- Both READMEs claimed 13 KB of JS gzipped. True when the package was written, and left
  alone while it grew to 22. A test now compares the sentence with the build.

## 2.0.0

The module rewritten as a package: a widget class with no dependencies and an upload handler
with no framework, replacing a single script that hung its buttons off `window` by name and
built its markup by concatenating file names into `innerHTML`.

The version before this one is in the repository's history; its README is kept in
[docs/README.original.md](docs/README.original.md).
