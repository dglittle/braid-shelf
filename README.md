# braid-shelf
Collaborative JSON over Braid-HTTP

This library provides a simple HTTP route handler, along with client code, enabling fast JSON synchronization over a standard protocol.

- Supports [Braid-HTTP](https://github.com/braid-org/braid-spec/blob/master/draft-toomim-httpbis-braid-http-04.txt) protocol
- Merges with [shelf-merge](https://github.com/braid-org/shelf-merge)
- Developed in [braid.org](https://braid.org)

### Demo

This will run a server with a collaboratively-editable JSON editor:

```shell
npm install
node server.js
```

Now open these URLs in your browser:
  - http://localhost:19999/demo?editor (to edit JSON collaboratively)
  - http://localhost:19999/any-other-path?editor (to create a new resource)

## General Use on Server

Install it in your project:
```shell
npm install braid-shelf
```

Import the request handler into your code, and use it to handle HTTP requests wherever you want:

```javascript
var braid_shelf = require("braid-shelf")

http_server.on("request", (req, res) => {
  // Your server logic...

  // Whenever desired, serve braid shelf for this request/response:
  braid_shelf.serve(req, res)
})
```

## Server API

`braid_shelf.db_folder = './braid_shelf_db' // <-- this is the default`
  - This is where the shelf history files will be stored for each resource.
  - This folder will be created if it doesn't exist.
  - The files for a resource will all be prefixed with a url-encoding of `key` within this folder.

`braid_shelf.serve(req, res, options)`
  - `req`: Incoming HTTP request object.
  - `res`: Outgoing HTTP response object.
  - `options`: An object containing additional options:
    - `key`: ID of JSON resource to sync with. Defaults to `req.url`.
  - Handles Braid-HTTP `GET`, `PUT`, and `DELETE` requests for a specific JSON resource.

`await braid_shelf.get(key)`
  - `key`: ID of JSON resource.
  - Returns the shelf `[data, version]` tuple, or `undefined` if it doesn't exist.

`await braid_shelf.get(key, options)`
  - `key`: ID of JSON resource.
  - `options`: An object containing additional options:
    - `subscribe: cb`: Subscribes to the state, and calls `cb` with the initial state and each update. The function `cb` will be called with `{version, body}`.
    - `peer`: Unique string ID that identifies the peer making the subscription. Mutations will not be echoed back to the same peer that `PUT`s them.

`await braid_shelf.put(key, options)`
  - `key`: ID of JSON resource.
  - `options`: An object containing:
    - `version`: The version being `PUT`, as an array of strings.
    - `body`: The JSON body as a string.
    - `peer`: Identifies this peer. This mutation will not be echoed back to subscriptions with the same peer.

`await braid_shelf.delete(key)`
  - `key`: ID of JSON resource.
  - Deletes the resource and its persistence files.

`await braid_shelf.list()`
  - Returns an array of all existing resource keys.

## General Use on Client

```html
<script src="https://unpkg.com/braid-http@~1.3/braid-http-client.js"></script>
<script src="https://unpkg.com/shelf-merge"></script>
<script>

let shelf = [null, 0]
let peer = Math.random().toString(36).substr(2)

// Subscribe to updates
braid_fetch('/my-resource', {
    subscribe: true,
    retry: true,
    peer,
}).then((res) => {
    res.subscribe((update) => {
        shelf_merge(shelf, [JSON.parse(update.body_text), JSON.parse(update.version[0])])
        console.log('Current data:', shelf[0])
    })
})

// Send an update
function put(new_data) {
    let change = shelf_merge(shelf, new_data)
    if (change) braid_fetch('/my-resource', {
        method: 'PUT',
        version: [JSON.stringify(change[1])],
        body: JSON.stringify(change[0])
    })
}

</script>
```

See [editor.html](editor.html) for a working example.
