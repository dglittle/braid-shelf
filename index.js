
let braidify = require("braid-http").http_server
let fs = require("fs")
let shelf_merge = require("shelf-merge")

let braid_shelf = {
    verbose: true,
    db_folder: './braid_shelf_db',
    cache: {},
    delete_cache: {}
}

braid_shelf.serve = async (req, res, options = {}) => {
    if (!options.key) options.key = req.url.split('?')[0]

    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "*")
    res.setHeader("Access-Control-Allow-Headers", "*")
    res.setHeader("Access-Control-Expose-Headers", "*")

    function my_end(statusCode, x) {
        res.statusCode = statusCode
        res.end(x ?? '')
    }

    let resource = await get_resource(options.key)
    braidify(req, res)

    let peer = req.headers["peer"]

    if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'application/json')

    // no matter what the content type is,
    // we want to set the charset to utf-8
    const contentType = res.getHeader('Content-Type')
    const parsedContentType = contentType.split(';').map(part => part.trim())
    const charsetParam = parsedContentType.find(part => part.toLowerCase().startsWith('charset='))
    if (!charsetParam)
        res.setHeader('Content-Type', `${contentType}; charset=utf-8`)
    else if (charsetParam.toLowerCase() !== 'charset=utf-8') {
        // Replace the existing charset with utf-8
        const updatedContentType = parsedContentType
            .map(part => (part.toLowerCase().startsWith('charset=') ? 'charset=utf-8' : part))
            .join('; ');
        res.setHeader('Content-Type', updatedContentType);
    }

    if (req.method == "OPTIONS") return my_end(200)

    if (req.method == "DELETE") {
        await braid_shelf.delete(resource)
        return my_end(200)
    }

    if (req.method == "GET" || req.method == "HEAD") {
        if (!req.subscribe) {
            res.setHeader("Accept-Subscribe", "true")

            let old_write = res.write
            let stuff_to_write = null
            res.write = x => stuff_to_write = x
            res.sendUpdate({
                version: [JSON.stringify(resource.shelf[1])],
                body: JSON.stringify(resource.shelf[0])
            })
            res.write = old_write

            if (req.method === "HEAD") return my_end(200)

            return my_end(200, stuff_to_write)
        } else {
            if (!res.hasHeader("editable")) res.setHeader("Editable", "true")
            res.setHeader("Merge-Type", 'shelf')
            if (req.method == "HEAD") return my_end(200)

            let options = {
                peer,
                subscribe: x => res.sendVersion(x),
                write: (x) => res.write(x)
            }

            res.startSubscription({ onClose: () => { resource.clients.delete(options) } })

            try {
                return await braid_shelf.get(resource, options)
            } catch (e) {
                return my_end(400, "The server failed to get something. The error generated was: " + (e?.stack ?? e))
            }
        }
    }

    if (req.method == "PUT" || req.method == "POST" || req.method == "PATCH") {
        let update = await req.parseUpdate()

        console.log(`update = ${JSON.stringify(update, null, 4)}`)
        console.log(`version = ${req.version}`)
        console.log(`parents = ${req.parents}`)

        await braid_shelf.put(resource, {
            peer,
            version: req.version,
            body: update.body_text
        })

        return my_end(200, '{"ok": true}')
    }

    throw new Error("unknown")
}

braid_shelf.delete = async (key) => {
    let resource = (typeof key == 'string') ? await get_resource(key) : key
    await resource.delete_me()
}

braid_shelf.get = async (key, options) => {
    if (!options) {
        // if it doesn't exist already, don't create it in this case
        if (!braid_shelf.cache[key]) return
        return (await get_resource(key)).shelf
    }

    let resource = (typeof key == 'string') ? await get_resource(key) : key

    if (!options.subscribe) {
        return resource.shelf
    } else {
        options.subscribe({
            version: [JSON.stringify(resource.shelf[1])],
            body: JSON.stringify(resource.shelf[0])
        })

        resource.clients.add(options)
    }
}

braid_shelf.forget = async (key, options) => {
    if (!options) throw new Error('options is required')

    let resource = (typeof key == 'string') ? await get_resource(key) : key

    resource.clients.delete(options)
}

braid_shelf.put = async (key, options) => {
    let resource = (typeof key == 'string') ? await get_resource(key) : key

    console.log('HI: ' + JSON.stringify({key, options}, null, 4))

    let delta = shelf_merge(resource.shelf, [JSON.parse(options.body), JSON.parse(options.version[0])])
    if (delta) {
        let x = {
            version: [JSON.stringify(delta[1])],
            body: JSON.stringify(delta[0])
        }
        for (let client of resource.clients) if (client.peer != options.peer) client.subscribe(x)

        await resource.db_delta(delta)
    }
}

braid_shelf.list = async () => {
    try {
        if (braid_shelf.db_folder) {
            await db_folder_init()
            var pages = new Set()
            for (let x of await fs.promises.readdir(braid_shelf.db_folder)) pages.add(decode_filename(x.replace(/\.\w+$/, '')))
            return [...pages.keys()]
        } else return Object.keys(braid_shelf.cache)
    } catch (e) { return [] }
}

async function get_resource(key) {
    if (braid_shelf.delete_cache[key]) await braid_shelf.delete_cache[key]

    if (!braid_shelf.cache[key]) braid_shelf.cache[key] = new Promise(async done => {
        let resource = { key }
        resource.clients = new Set()

        resource.shelf = [null, 0]

        let { change, delete_me } = braid_shelf.db_folder
            ? await file_sync(key,
                (o) => shelf_merge(resource.shelf, o),
                () => resource.shelf)
            : { change: () => { }, delete_me: () => { } }

        resource.db_delta = change

        resource.delete_me = async () => {
            delete braid_shelf.cache[key]
            await (braid_shelf.delete_cache[key] = delete_me())
        }

        done(resource)
    })
    return await braid_shelf.cache[key]
}

async function db_folder_init() {
    if (braid_shelf.verbose) console.log('db_folder_init called')
    if (!db_folder_init.p) db_folder_init.p = fs.promises.mkdir(braid_shelf.db_folder, { recursive: true })
    await db_folder_init.p
}

async function get_files_for_key(key) {
    await db_folder_init()
    try {
        let re = new RegExp("^" + encode_filename(key).replace(/[^a-zA-Z0-9]/g, "\\$&") + "\\.\\w+$")
        return (await fs.promises.readdir(braid_shelf.db_folder))
            .filter((a) => re.test(a))
            .map((a) => `${braid_shelf.db_folder}/${a}`)
    } catch (e) { return [] }
}

async function file_sync(key, process_delta, get_init) {
    let encoded = encode_filename(key)

    let currentNumber = 0
    let currentSize = 0
    let threshold = 0

    // Read existing files and sort by numbers.
    const files = (await get_files_for_key(key))
        .filter(x => x.match(/\.\d+$/))
        .sort((a, b) => parseInt(a.match(/\d+$/)[0]) - parseInt(b.match(/\d+$/)[0]))

    // Try to process files starting from the highest number.
    let done = false
    for (let i = files.length - 1; i >= 0; i--) {
        if (done) {
            await fs.promises.unlink(files[i])
            continue
        }
        try {
            const filename = files[i]
            if (braid_shelf.verbose) console.log(`trying to process file: ${filename}`)
            const data = await fs.promises.readFile(filename, 'utf8')

            const chunks = data.split('\n')

            threshold = chunks[0].length * 10

            for (const chunk of chunks) process_delta(JSON.parse(chunk))

            currentSize = data.length
            currentNumber = parseInt(filename.match(/\d+$/)[0])
            done = true
        } catch (error) {
            console.error(`Error processing file: ${files[i]}`)
            await fs.promises.unlink(files[i])
        }
    }

    let deleted = false
    let chain = Promise.resolve()
    return {
        change: async (o) => {
            if (deleted) return
            await (chain = chain.then(async () => {
                let bytes = new TextEncoder().encode('\n' + JSON.stringify(o))
                currentSize += bytes.length
                const filename = `${braid_shelf.db_folder}/${encoded}.${currentNumber}`
                if (currentSize < threshold) {
                    if (braid_shelf.verbose) console.log(`appending to db..`)

                    await fs.promises.appendFile(filename, bytes)

                    if (braid_shelf.verbose) console.log("wrote to : " + filename)
                } else {
                    try {
                        if (braid_shelf.verbose) console.log(`starting new db..`)

                        currentNumber++
                        bytes = new TextEncoder().encode(JSON.stringify(get_init()))

                        const newFilename = `${braid_shelf.db_folder}/${encoded}.${currentNumber}`
                        await fs.promises.writeFile(newFilename, bytes)

                        if (braid_shelf.verbose) console.log("wrote to : " + newFilename)

                        currentSize = bytes.length
                        threshold = currentSize * 10
                        try {
                            await fs.promises.unlink(filename)
                        } catch (e) { }
                    } catch (e) {
                        if (braid_shelf.verbose) console.log(`e = ${e.stack}`)
                    }
                }
            }))
        },
        delete_me: async () => {
            deleted = true
            await (chain = chain.then(async () => {
                await Promise.all(
                    (
                        await get_files_for_key(key)
                    ).map((file) => {
                        return new Promise((resolve, reject) => {
                            fs.unlink(file, (err) => {
                                if (err) {
                                    console.error(`Error deleting file: ${file}`)
                                    reject(err)
                                } else {
                                    if (braid_shelf.verbose) console.log(`Deleted file: ${file}`)
                                    resolve()
                                }
                            })
                        })
                    })
                )
            }))
        },
    }
}

//////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////

function encode_filename(filename) {
    // Swap all "!" and "/" characters
    let swapped = filename.replace(/[!/]/g, (match) => (match === "!" ? "/" : "!"))

    // Encode the filename using encodeURIComponent()
    let encoded = encodeURIComponent(swapped)

    return encoded
}

function decode_filename(encodedFilename) {
    // Decode the filename using decodeURIComponent()
    let decoded = decodeURIComponent(encodedFilename)

    // Swap all "/" and "!" characters
    decoded = decoded.replace(/[!/]/g, (match) => (match === "/" ? "!" : "/"))

    return decoded
}

braid_shelf.encode_filename = encode_filename
braid_shelf.decode_filename = decode_filename

module.exports = braid_shelf
