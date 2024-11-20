const { version } = require("os")

let braidify = require("braid-http").http_server

let braid_shelf = {
    db_folder: './braid_shelf_db',
    cache: {},
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
                merge_type,
                subscribe: x => res.sendVersion(x),
                write: (x) => res.write(x)
            }

            res.startSubscription({ onClose: () => {resource.clients.delete(options)} })

            try {
                return await braid_shelf.get(resource, options)
            } catch (e) {
                return my_end(400, "The server failed to get something. The error generated was: " + e)
            }
        }
    }

    if (req.method == "PUT" || req.method == "POST" || req.method == "PATCH") {
        let update = await req.parseUpdate()

        await braid_text.put(resource, update)

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
        {
            let updates = null

            options.subscribe({
                version: [JSON.stringify(resource.shelf[1])],
                body: JSON.stringify(resource.shelf[0])
            })

            // Output at least *some* data, or else chrome gets confused and
            // thinks the connection failed.  This isn't strictly necessary,
            // but it makes fewer scary errors get printed out in the JS
            // console.
            if (updates.length === 0) options.write?.("\r\n")

            resource.clients.add(options)
        }
    }
}

braid_text.forget = async (key, options) => {
    if (!options) throw new Error('options is required')

    let resource = (typeof key == 'string') ? await get_resource(key) : key

    resource.clients.delete(options)
}

braid_text.put = async (key, options) => {
    let { version, body } = options

    let resource = (typeof key == 'string') ? await get_resource(key) : key

    let delta = shelf_merge(resource.shelf, [JSON.parse(body), JSON.parse(version[0])])

    for (let client of resource.clients) {
        if (client.peer != peer) client.subscribe(options)
    }

    await resource.db_delta(resource.doc.getPatchSince(v_before))
}

braid_text.list = async () => {
    try {
        if (braid_text.db_folder) {
            await db_folder_init()
            var pages = new Set()
            for (let x of await require('fs').promises.readdir(braid_text.db_folder)) pages.add(decode_filename(x.replace(/\.\w+$/, '')))
            return [...pages.keys()]
        } else return Object.keys(braid_text.cache)
    } catch (e) { return [] }
}

async function get_resource(key) {
    if (braid_text.delete_cache[key]) await braid_text.delete_cache[key]

    let cache = braid_text.cache
    if (!cache[key]) cache[key] = new Promise(async done => {
        let resource = {key}
        resource.clients = new Set()
        resource.simpleton_clients = new Set()

        resource.doc = new Doc("server")

        let { change, delete_me } = braid_text.db_folder
            ? await file_sync(key,
                (bytes) => resource.doc.mergeBytes(bytes),
                () => resource.doc.toBytes())
            : { change: () => { }, delete_me: () => { } }

        resource.db_delta = change

        resource.doc = defrag_dt(resource.doc)
        resource.need_defrag = false

        resource.actor_seqs = {}
        let max_version = Math.max(...resource.doc.getLocalVersion()) ?? -1
        for (let i = 0; i <= max_version; i++) {
            let v = resource.doc.localToRemoteVersion([i])[0]
            resource.actor_seqs[v[0]] = Math.max(v[1], resource.actor_seqs[v[0]] ?? -1)
        }

        resource.delete_me = async () => {
            delete cache[key]
            await (braid_text.delete_cache[key] = delete_me())
        }

        resource.val = resource.doc.get()

        resource.length_cache = createSimpleCache(braid_text.length_cache_size)

        done(resource)
    })
    return await cache[key]
}

async function db_folder_init() {
    if (braid_text.verbose) console.log('__!')
    if (!db_folder_init.p) db_folder_init.p = new Promise(async done => {
        await fs.promises.mkdir(braid_text.db_folder, { recursive: true });

        // 0.0.13 -> 0.0.14
        // look for files with key-encodings over max_encoded_key_size,
        // and convert them using the new method
        // for (let x of await fs.promises.readdir(braid_text.db_folder)) {
        //     let k = x.replace(/(_[0-9a-f]{64})?\.\w+$/, '')
        //     if (k.length > max_encoded_key_size) {
        //         k = decode_filename(k)

        //         await fs.promises.rename(`${braid_text.db_folder}/${x}`, `${braid_text.db_folder}/${encode_filename(k)}${x.match(/\.\w+$/)[0]}`)
        //         await fs.promises.writeFile(`${braid_text.db_folder}/${encode_filename(k)}.name`, k)
        //     }
        // }

        // 0.0.14 -> 0.0.15
        // basically convert the 0.0.14 files back
        let convert_us = {}
        for (let x of await fs.promises.readdir(braid_text.db_folder)) {
            if (x.endsWith('.name')) {
                let encoded = convert_us[x.slice(0, -'.name'.length)] = encode_filename(await fs.promises.readFile(`${braid_text.db_folder}/${x}`, { encoding: 'utf8' }))
                if (encoded.length > max_encoded_key_size) {
                    console.log(`trying to convert file to new format, but the key is too big: ${braid_text.db_folder}/${x}`)
                    process.exit()
                }
                if (braid_text.verbose) console.log(`deleting: ${braid_text.db_folder}/${x}`)
                await fs.promises.unlink(`${braid_text.db_folder}/${x}`)
            }
        }
        if (Object.keys(convert_us).length) {
            for (let x of await fs.promises.readdir(braid_text.db_folder)) {
                let [_, k, num] = x.match(/^(.*)\.(\d+)$/s)
                if (!convert_us[k]) continue
                if (braid_text.verbose) console.log(`renaming: ${braid_text.db_folder}/${x} -> ${braid_text.db_folder}/${convert_us[k]}.${num}`)
                if (convert_us[k]) await fs.promises.rename(`${braid_text.db_folder}/${x}`, `${braid_text.db_folder}/${convert_us[k]}.${num}`)
            }
        }

        done()
    })
    await db_folder_init.p
}

async function get_files_for_key(key) {
    await db_folder_init()
    try {
        let re = new RegExp("^" + encode_filename(key).replace(/[^a-zA-Z0-9]/g, "\\$&") + "\\.\\w+$")
        return (await fs.promises.readdir(braid_text.db_folder))
            .filter((a) => re.test(a))
            .map((a) => `${braid_text.db_folder}/${a}`)
    } catch (e) { return [] }    
}

async function file_sync(key, process_delta, get_init) {
    let encoded = encode_filename(key)

    if (encoded.length > max_encoded_key_size) throw new Error(`invalid key: too long (max ${max_encoded_key_size})`)

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
            if (braid_text.verbose) console.log(`trying to process file: ${filename}`)
            const data = await fs.promises.readFile(filename)

            let cursor = 0
            let isFirstChunk = true
            while (cursor < data.length) {
                const chunkSize = data.readUInt32LE(cursor)
                cursor += 4
                const chunk = data.slice(cursor, cursor + chunkSize)
                cursor += chunkSize

                if (isFirstChunk) {
                    isFirstChunk = false
                    threshold = chunkSize * 10
                }
                process_delta(chunk)
            }

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
        change: async (bytes) => {
            if (deleted) return
            await (chain = chain.then(async () => {
                currentSize += bytes.length + 4 // we account for the extra 4 bytes for uint32
                const filename = `${braid_text.db_folder}/${encoded}.${currentNumber}`
                if (currentSize < threshold) {
                    if (braid_text.verbose) console.log(`appending to db..`)

                    let buffer = Buffer.allocUnsafe(4)
                    buffer.writeUInt32LE(bytes.length, 0)
                    await fs.promises.appendFile(filename, buffer)
                    await fs.promises.appendFile(filename, bytes)

                    if (braid_text.verbose) console.log("wrote to : " + filename)
                } else {
                    try {
                        if (braid_text.verbose) console.log(`starting new db..`)

                        currentNumber++
                        const init = get_init()
                        const buffer = Buffer.allocUnsafe(4)
                        buffer.writeUInt32LE(init.length, 0)

                        const newFilename = `${braid_text.db_folder}/${encoded}.${currentNumber}`
                        await fs.promises.writeFile(newFilename, buffer)
                        await fs.promises.appendFile(newFilename, init)

                        if (braid_text.verbose) console.log("wrote to : " + newFilename)

                        currentSize = 4 + init.length
                        threshold = currentSize * 10
                        try {
                            await fs.promises.unlink(filename)
                        } catch (e) { }
                    } catch (e) {
                        if (braid_text.verbose) console.log(`e = ${e.stack}`)
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
                                    if (braid_text.verbose) console.log(`Deleted file: ${file}`)
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

function dt_get(doc, version, agent = null) {
    if (dt_get.last_doc) dt_get.last_doc.free()

    let bytes = doc.toBytes()
    dt_get.last_doc = doc = Doc.fromBytes(bytes, agent)

    let [_agents, versions, parentss] = dt_parse([...bytes])

    let frontier = {}
    version.forEach((x) => frontier[x] = true)

    let local_version = []
    for (let i = 0; i < versions.length; i++)
        if (frontier[versions[i].join("-")]) local_version.push(i)
    dt_get.last_local_version = local_version = new Uint32Array(local_version)

    let after_versions = {}
    let [_, after_versions_array, __] = dt_parse([...doc.getPatchSince(local_version)])
    for (let v of after_versions_array) after_versions[v.join("-")] = true

    let new_doc = new Doc(agent)
    let op_runs = doc.getOpsSince([])

    let i = 0
    op_runs.forEach((op_run) => {
        if (op_run.content) op_run.content = [...op_run.content]

        let len = op_run.end - op_run.start
        let base_i = i
        for (let j = 1; j <= len; j++) {
            let I = base_i + j
            if (
                j == len ||
                parentss[I].length != 1 ||
                parentss[I][0][0] != versions[I - 1][0] ||
                parentss[I][0][1] != versions[I - 1][1] ||
                versions[I][0] != versions[I - 1][0] ||
                versions[I][1] != versions[I - 1][1] + 1
            ) {
                for (; i < I; i++) {
                    let version = versions[i].join("-")
                    if (!after_versions[version]) new_doc.mergeBytes(
                        dt_create_bytes(
                            version,
                            parentss[i].map((x) => x.join("-")),
                            op_run.fwd ?
                                (op_run.content ?
                                    op_run.start + (i - base_i) :
                                    op_run.start) :
                                op_run.end - 1 - (i - base_i),
                            op_run.content?.[i - base_i] != null ? 0 : 1,
                            op_run.content?.[i - base_i]
                        )
                    )
                }
            }
        }
    })
    return new_doc
}

function dt_get_patches(doc, version = null) {
    let bytes = doc.toBytes()
    doc = Doc.fromBytes(bytes)

    let [_agents, versions, parentss] = dt_parse([...bytes])

    let op_runs = []
    if (version) {
        let frontier = {}
        version.forEach((x) => frontier[x] = true)
        let local_version = []
        for (let i = 0; i < versions.length; i++)
            if (frontier[versions[i].join("-")]) local_version.push(i)
        let after_bytes = doc.getPatchSince(new Uint32Array(local_version))

        ;[_agents, versions, parentss] = dt_parse([...after_bytes])

        let before_doc = dt_get(doc, version)
        let before_doc_frontier = before_doc.getLocalVersion()

        before_doc.mergeBytes(after_bytes)
        op_runs = before_doc.getOpsSince(before_doc_frontier)

        before_doc.free()
    } else op_runs = doc.getOpsSince([])

    doc.free()

    let i = 0
    let patches = []
    op_runs.forEach((op_run) => {
        let version = versions[i]
        let parents = parentss[i].map((x) => x.join("-")).sort()
        let start = op_run.start
        let end = start + 1
        if (op_run.content) op_run.content = [...op_run.content]
        let len = op_run.end - op_run.start
        for (let j = 1; j <= len; j++) {
            let I = i + j
            if (
                (!op_run.content && op_run.fwd) ||
                j == len ||
                parentss[I].length != 1 ||
                parentss[I][0][0] != versions[I - 1][0] ||
                parentss[I][0][1] != versions[I - 1][1] ||
                versions[I][0] != versions[I - 1][0] ||
                versions[I][1] != versions[I - 1][1] + 1
            ) {
                let s = op_run.fwd ?
                    (op_run.content ?
                        start :
                        op_run.start) :
                    (op_run.start + (op_run.end - end))
                let e = op_run.fwd ?
                    (op_run.content ?
                        end :
                        op_run.start + (end - start)) :
                    (op_run.end - (start - op_run.start))
                patches.push({
                    version: `${version[0]}-${version[1] + e - s - 1}`,
                    parents,
                    unit: "text",
                    range: op_run.content ? `[${s}:${s}]` : `[${s}:${e}]`,
                    content: op_run.content?.slice(start - op_run.start, end - op_run.start).join("") ?? "",
                    start: s,
                    end: e,
                })
                if (j == len) break
                version = versions[I]
                parents = parentss[I].map((x) => x.join("-")).sort()
                start = op_run.start + j
            }
            end++
        }
        i += len
    })
    return patches
}

function dt_parse(byte_array) {
    if (new TextDecoder().decode(new Uint8Array(byte_array.splice(0, 8))) !== "DMNDTYPS") throw new Error("dt parse error, expected DMNDTYPS")

    if (byte_array.shift() != 0) throw new Error("dt parse error, expected version 0")

    let agents = []
    let versions = []
    let parentss = []

    while (byte_array.length) {
        let id = byte_array.shift()
        let len = read_varint(byte_array)
        if (id == 1) {
        } else if (id == 3) {
            let goal = byte_array.length - len
            while (byte_array.length > goal) {
                agents.push(read_string(byte_array))
            }
        } else if (id == 20) {
        } else if (id == 21) {
            let seqs = {}
            let goal = byte_array.length - len
            while (byte_array.length > goal) {
                let part0 = read_varint(byte_array)
                let has_jump = part0 & 1
                let agent_i = (part0 >> 1) - 1
                let run_length = read_varint(byte_array)
                let jump = 0
                if (has_jump) {
                    let part2 = read_varint(byte_array)
                    jump = part2 >> 1
                    if (part2 & 1) jump *= -1
                }
                let base = (seqs[agent_i] || 0) + jump

                for (let i = 0; i < run_length; i++) {
                    versions.push([agents[agent_i], base + i])
                }
                seqs[agent_i] = base + run_length
            }
        } else if (id == 23) {
            let count = 0
            let goal = byte_array.length - len
            while (byte_array.length > goal) {
                let run_len = read_varint(byte_array)

                let parents = []
                let has_more = 1
                while (has_more) {
                    let x = read_varint(byte_array)
                    let is_foreign = 0x1 & x
                    has_more = 0x2 & x
                    let num = x >> 2

                    if (x == 1) {
                        // no parents (e.g. parent is "root")
                    } else if (!is_foreign) {
                        parents.push(versions[count - num])
                    } else {
                        parents.push([agents[num - 1], read_varint(byte_array)])
                    }
                }
                parentss.push(parents)
                count++

                for (let i = 0; i < run_len - 1; i++) {
                    parentss.push([versions[count - 1]])
                    count++
                }
            }
        } else {
            byte_array.splice(0, len)
        }
    }

    function read_string(byte_array) {
        return new TextDecoder().decode(new Uint8Array(byte_array.splice(0, read_varint(byte_array))))
    }

    function read_varint(byte_array) {
        let result = 0
        let shift = 0
        while (true) {
            if (byte_array.length === 0) throw new Error("byte array does not contain varint")

            let byte_val = byte_array.shift()
            result |= (byte_val & 0x7f) << shift
            if ((byte_val & 0x80) == 0) return result
            shift += 7
        }
    }

    return [agents, versions, parentss]
}

function dt_create_bytes(version, parents, pos, del, ins) {
    if (del) pos += del - 1

    function write_varint(bytes, value) {
        while (value >= 0x80) {
            bytes.push((value & 0x7f) | 0x80)
            value >>= 7
        }
        bytes.push(value)
    }

    function write_string(byte_array, str) {
        let str_bytes = new TextEncoder().encode(str)
        write_varint(byte_array, str_bytes.length)
        byte_array.push(...str_bytes)
    }

    version = decode_version(version)
    parents = parents.map(decode_version)

    let bytes = []
    bytes = bytes.concat(Array.from(new TextEncoder().encode("DMNDTYPS")))
    bytes.push(0)

    let file_info = []
    let agent_names = []

    let agents = new Set()
    agents.add(version[0])
    for (let p of parents) agents.add(p[0])
    agents = [...agents]

    //   console.log(JSON.stringify({ agents, parents }, null, 4));

    let agent_to_i = {}
    for (let [i, agent] of agents.entries()) {
        agent_to_i[agent] = i
        write_string(agent_names, agent)
    }

    file_info.push(3)
    write_varint(file_info, agent_names.length)
    file_info.push(...agent_names)

    bytes.push(1)
    write_varint(bytes, file_info.length)
    bytes.push(...file_info)

    let branch = []

    if (parents.length) {
        let frontier = []

        for (let [i, [agent, seq]] of parents.entries()) {
            let has_more = i < parents.length - 1
            let mapped = agent_to_i[agent]
            let n = ((mapped + 1) << 1) | (has_more ? 1 : 0)
            write_varint(frontier, n)
            write_varint(frontier, seq)
        }

        branch.push(12)
        write_varint(branch, frontier.length)
        branch.push(...frontier)
    }

    bytes.push(10)
    write_varint(bytes, branch.length)
    bytes.push(...branch)

    let patches = []

    let unicode_chars = ins ? [...ins] : []

    if (ins) {
        let inserted_content_bytes = []

        inserted_content_bytes.push(0) // ins (not del, which is 1)

        inserted_content_bytes.push(13) // "content" enum (rather than compressed)

        let encoder = new TextEncoder()
        let utf8Bytes = encoder.encode(ins)

        write_varint(inserted_content_bytes, 1 + utf8Bytes.length)
        // inserted_content_bytes.push(1 + utf8Bytes.length) // length of content chunk
        inserted_content_bytes.push(4) // "plain text" enum

        for (let b of utf8Bytes) inserted_content_bytes.push(b) // actual text

        inserted_content_bytes.push(25) // "known" enum
        let known_chunk = []
        write_varint(known_chunk, unicode_chars.length * 2 + 1)
        write_varint(inserted_content_bytes, known_chunk.length)
        inserted_content_bytes.push(...known_chunk)

        patches.push(24)
        write_varint(patches, inserted_content_bytes.length)
        for (let b of inserted_content_bytes) patches.push(b)
    }

    // write in the version
    let version_bytes = []

    let [agent, seq] = version
    let agent_i = agent_to_i[agent]
    let jump = seq

    write_varint(version_bytes, ((agent_i + 1) << 1) | (jump != 0 ? 1 : 0))
    write_varint(version_bytes, ins ? unicode_chars.length : del)
    if (jump) write_varint(version_bytes, jump << 1)

    patches.push(21)
    write_varint(patches, version_bytes.length)
    for (let b of version_bytes) patches.push(b)

    // write in "op" bytes (some encoding of position)
    let op_bytes = []

    if (del) {
        if (pos == 0) {
            write_varint(op_bytes, 4)
        } else if (del == 1) {
            write_varint(op_bytes, pos * 16 + 6)
        } else {
            write_varint(op_bytes, del * 16 + 7)
            write_varint(op_bytes, pos * 2 + 2)
        }
    } else if (unicode_chars.length == 1) {
        if (pos == 0) write_varint(op_bytes, 0)
        else write_varint(op_bytes, pos * 16 + 2)
    } else if (pos == 0) {
        write_varint(op_bytes, unicode_chars.length * 8 + 1)
    } else {
        write_varint(op_bytes, unicode_chars.length * 8 + 3)
        write_varint(op_bytes, pos * 2)
    }

    patches.push(22)
    write_varint(patches, op_bytes.length)
    for (let b of op_bytes) patches.push(b)

    // write in parents
    let parents_bytes = []

    write_varint(parents_bytes, ins ? unicode_chars.length : del)

    if (parents.length) {
        for (let [i, [agent, seq]] of parents.entries()) {
            let has_more = i < parents.length - 1
            let agent_i = agent_to_i[agent]
            write_varint(parents_bytes, ((agent_i + 1) << 2) | (has_more ? 2 : 0) | 1)
            write_varint(parents_bytes, seq)
        }
    } else write_varint(parents_bytes, 1)

    patches.push(23)
    write_varint(patches, parents_bytes.length)
    patches.push(...parents_bytes)

    // write in patches
    bytes.push(20)
    write_varint(bytes, patches.length)
    for (let b of patches) bytes.push(b)

    //   console.log(bytes);
    return bytes
}

function defrag_dt(doc) {
    let bytes = doc.toBytes()
    doc.free()
    return Doc.fromBytes(bytes, 'server')
}

function OpLog_remote_to_local(doc, frontier) {
    let map = Object.fromEntries(frontier.map((x) => [x, true]))

    let local_version = []

    let max_version = Math.max(-1, ...doc.getLocalVersion())
    for (let i = 0; i <= max_version; i++) {
        if (map[doc.localToRemoteVersion([i])[0].join("-")]) {
            local_version.push(i)
        }
    }

    return frontier.length == local_version.length && new Uint32Array(local_version)
}

function v_eq(v1, v2) {
    return v1.length == v2.length && v1.every((x, i) => x == v2[i])
}

function get_xf_patches(doc, v) {
    let patches = []
    for (let xf of doc.xfSince(v)) {
        patches.push(
            xf.kind == "Ins"
                ? {
                    unit: "text",
                    range: `[${xf.start}:${xf.start}]`,
                    content: xf.content,
                }
                : {
                    unit: "text",
                    range: `[${xf.start}:${xf.end}]`,
                    content: "",
                }
        )
    }
    return relative_to_absolute_patches(patches)
}

function relative_to_absolute_patches(patches) {
    let avl = create_avl_tree((node) => {
        let parent = node.parent
        if (parent.left == node) {
            parent.left_size -= node.left_size + node.size
        } else {
            node.left_size += parent.left_size + parent.size
        }
    })
    avl.root.size = Infinity
    avl.root.left_size = 0

    function resize(node, new_size) {
        if (node.size == new_size) return
        let delta = new_size - node.size
        node.size = new_size
        while (node.parent) {
            if (node.parent.left == node) node.parent.left_size += delta
            node = node.parent
        }
    }

    for (let p of patches) {
        let [start, end] = p.range.match(/\d+/g).map((x) => 1 * x)
        let del = end - start

        let node = avl.root
        while (true) {
            if (start < node.left_size || (node.left && node.content == null && start == node.left_size)) {
                node = node.left
            } else if (start > node.left_size + node.size || (node.content == null && start == node.left_size + node.size)) {
                start -= node.left_size + node.size
                node = node.right
            } else {
                start -= node.left_size
                break
            }
        }

        let remaining = start + del - node.size
        if (remaining < 0) {
            if (node.content == null) {
                if (start > 0) {
                    let x = { size: 0, left_size: 0 }
                    avl.add(node, "left", x)
                    resize(x, start)
                }
                let x = { size: 0, left_size: 0, content: p.content, del }
                avl.add(node, "left", x)
                resize(x, count_code_points(x.content))
                resize(node, node.size - (start + del))
            } else {
                node.content = node.content.slice(0, codePoints_to_index(node.content, start)) + p.content + node.content.slice(codePoints_to_index(node.content, start + del))
                resize(node, count_code_points(node.content))
            }
        } else {
            let next
            let middle_del = 0
            while (remaining >= (next = avl.next(node)).size) {
                remaining -= next.size
                middle_del += next.del ?? next.size
                resize(next, 0)
                avl.del(next)
            }

            if (node.content == null) {
                if (next.content == null) {
                    if (start == 0) {
                        node.content = p.content
                        node.del = node.size + middle_del + remaining
                        resize(node, count_code_points(node.content))
                    } else {
                        let x = {
                            size: 0,
                            left_size: 0,
                            content: p.content,
                            del: node.size - start + middle_del + remaining,
                        }
                        resize(node, start)
                        avl.add(node, "right", x)
                        resize(x, count_code_points(x.content))
                    }
                    resize(next, next.size - remaining)
                } else {
                    next.del += node.size - start + middle_del
                    next.content = p.content + next.content.slice(codePoints_to_index(next.content, remaining))
                    resize(node, start)
                    if (node.size == 0) avl.del(node)
                    resize(next, count_code_points(next.content))
                }
            } else {
                if (next.content == null) {
                    node.del += middle_del + remaining
                    node.content = node.content.slice(0, codePoints_to_index(node.content, start)) + p.content
                    resize(node, count_code_points(node.content))
                    resize(next, next.size - remaining)
                } else {
                    node.del += middle_del + next.del
                    node.content = node.content.slice(0, codePoints_to_index(node.content, start)) + p.content + next.content.slice(codePoints_to_index(next.content, remaining))
                    resize(node, count_code_points(node.content))
                    resize(next, 0)
                    avl.del(next)
                }
            }
        }
    }

    let new_patches = []
    let offset = 0
    let node = avl.root
    while (node.left) node = node.left
    while (node) {
        if (node.content == null) {
            offset += node.size
        } else {
            new_patches.push({
                unit: patches[0].unit,
                range: `[${offset}:${offset + node.del}]`,
                content: node.content,
            })
            offset += node.del
        }

        node = avl.next(node)
    }
    return new_patches
}

function create_avl_tree(on_rotate) {
    let self = { root: { height: 1 } }

    self.calc_height = (node) => {
        node.height = 1 + Math.max(node.left?.height ?? 0, node.right?.height ?? 0)
    }

    self.rechild = (child, new_child) => {
        if (child.parent) {
            if (child.parent.left == child) {
                child.parent.left = new_child
            } else {
                child.parent.right = new_child
            }
        } else {
            self.root = new_child
        }
        if (new_child) new_child.parent = child.parent
    }

    self.rotate = (node) => {
        on_rotate(node)

        let parent = node.parent
        let left = parent.right == node ? "left" : "right"
        let right = parent.right == node ? "right" : "left"

        parent[right] = node[left]
        if (parent[right]) parent[right].parent = parent
        self.calc_height(parent)

        self.rechild(parent, node)
        parent.parent = node

        node[left] = parent
    }

    self.fix_avl = (node) => {
        self.calc_height(node)
        let diff = (node.right?.height ?? 0) - (node.left?.height ?? 0)
        if (Math.abs(diff) >= 2) {
            if (diff > 0) {
                if ((node.right.left?.height ?? 0) > (node.right.right?.height ?? 0)) self.rotate(node.right.left)
                self.rotate((node = node.right))
            } else {
                if ((node.left.right?.height ?? 0) > (node.left.left?.height ?? 0)) self.rotate(node.left.right)
                self.rotate((node = node.left))
            }
            self.fix_avl(node)
        } else if (node.parent) self.fix_avl(node.parent)
    }

    self.add = (node, side, add_me) => {
        let other_side = side == "left" ? "right" : "left"
        add_me.height = 1

        if (node[side]) {
            node = node[side]
            while (node[other_side]) node = node[other_side]
            node[other_side] = add_me
        } else {
            node[side] = add_me
        }
        add_me.parent = node
        self.fix_avl(node)
    }

    self.del = (node) => {
        if (node.left && node.right) {
            let cursor = node.right
            while (cursor.left) cursor = cursor.left
            cursor.left = node.left

            // breaks abstraction
            cursor.left_size = node.left_size
            let y = cursor
            while (y.parent != node) {
                y = y.parent
                y.left_size -= cursor.size
            }

            node.left.parent = cursor
            if (cursor == node.right) {
                self.rechild(node, cursor)
                self.fix_avl(cursor)
            } else {
                let x = cursor.parent
                self.rechild(cursor, cursor.right)
                cursor.right = node.right
                node.right.parent = cursor
                self.rechild(node, cursor)
                self.fix_avl(x)
            }
        } else {
            self.rechild(node, node.left || node.right || null)
            if (node.parent) self.fix_avl(node.parent)
        }
    }

    self.next = (node) => {
        if (node.right) {
            node = node.right
            while (node.left) node = node.left
            return node
        } else {
            while (node.parent && node.parent.right == node) node = node.parent
            return node.parent
        }
    }

    return self
}

function count_code_points(str) {
    let code_points = 0;
    for (let i = 0; i < str.length; i++) {
        if (str.charCodeAt(i) >= 0xD800 && str.charCodeAt(i) <= 0xDBFF) i++;
        code_points++;
    }
    return code_points;
}

function index_to_codePoints(str, index) {
    let i = 0
    let c = 0
    while (i < index && i < str.length) {
        const charCode = str.charCodeAt(i)
        i += (charCode >= 0xd800 && charCode <= 0xdbff) ? 2 : 1
        c++
    }
    return c
}

function codePoints_to_index(str, codePoints) {
    let i = 0
    let c = 0
    while (c < codePoints && i < str.length) {
        const charCode = str.charCodeAt(i)
        i += (charCode >= 0xd800 && charCode <= 0xdbff) ? 2 : 1
        c++
    }
    return i
}

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

function validate_version_array(x) {
    if (!Array.isArray(x)) throw new Error(`invalid version array: not an array`)
    x.sort()
    for (xx of x) validate_actor_seq(xx)
}

function validate_actor_seq(x) {
    if (typeof x !== 'string') throw new Error(`invalid actor-seq: not a string`)
    let [actor, seq] = decode_version(x)
    validate_actor(actor)
}

function validate_actor(x) {
    if (typeof x !== 'string') throw new Error(`invalid actor: not a string`)
    if (Buffer.byteLength(x, 'utf8') >= 50) throw new Error(`actor value too long (max 49): ${x}`) // restriction coming from dt
}

function is_valid_actor(x) {
    try {
        validate_actor(x)
        return true
    } catch (e) { }
}

function decode_version(v) {
    let m = v.match(/^(.*)-(\d+)$/s)
    if (!m) throw new Error(`invalid actor-seq version: ${v}`)
    return [m[1], parseInt(m[2])]
}

function validate_patches(patches) {
    if (!Array.isArray(patches)) throw new Error(`invalid patches: not an array`)
    for (let p of patches) validate_patch(p)
}

function validate_patch(x) {
    if (typeof x != 'object') throw new Error(`invalid patch: not an object`)
    if (x.unit && x.unit !== 'text') throw new Error(`invalid patch unit '${x.unit}': only 'text' supported`)
    if (typeof x.range !== 'string') throw new Error(`invalid patch range: must be a string`)
    if (!x.range.match(/^\s*\[\s*\d+\s*:\s*\d+\s*\]\s*$/)) throw new Error(`invalid patch range: ${x.range}`)
    if (typeof x.content !== 'string') throw new Error(`invalid patch content: must be a string`)
}

function createSimpleCache(size) {
    const maxSize = size
    const cache = new Map()

    return {
        put(key, value) {
            if (cache.has(key)) {
                // If the key already exists, update its value and move it to the end
                cache.delete(key)
                cache.set(key, value)
            } else {
                // If the cache is full, remove the oldest entry
                if (cache.size >= maxSize) {
                    const oldestKey = cache.keys().next().value
                    cache.delete(oldestKey)
                }
                // Add the new key-value pair
                cache.set(key, value)
            }
        },

        get(key) {
            if (!cache.has(key)) {
                return null
            }
            // Move the accessed item to the end (most recently used)
            const value = cache.get(key)
            cache.delete(key)
            cache.set(key, value)
            return value
        },
    }
}

function apply_patch(obj, range, content) {

    // Descend down a bunch of objects until we get to the final object
    // The final object can be a slice
    // Set the value in the final object

    var path = range,
        new_stuff = content

    var path_segment = /^(\.?([^\.\[]+))|(\[((-?\d+):)?(-?\d+)\])|\[("(\\"|[^"])*")\]/
    var curr_obj = obj,
        last_obj = null

    // Handle negative indices, like "[-9]" or "[-0]"
    function de_neg (x) {
        return x[0] === '-'
            ? curr_obj.length - parseInt(x.substr(1), 10)
            : parseInt(x, 10)
    }

    // Now iterate through each segment of the range e.g. [3].a.b[3][9]
    while (true) {
        var match = path_segment.exec(path),
            subpath = match ? match[0] : '',
            field = match && match[2],
            slice_start = match && match[5],
            slice_end = match && match[6],
            quoted_field = match && match[7]

        // The field could be expressed as ["nnn"] instead of .nnn
        if (quoted_field) field = JSON.parse(quoted_field)

        slice_start = slice_start && de_neg(slice_start)
        slice_end = slice_end && de_neg(slice_end)

        // console.log('Descending', {curr_obj, path, subpath, field, slice_start, slice_end, last_obj})

        // If it's the final item, set it
        if (path.length === subpath.length) {
            if (!subpath) return new_stuff
            else if (field) {                           // Object
                if (new_stuff === undefined)
                    delete curr_obj[field]              // - Delete a field in object
                else
                    curr_obj[field] = new_stuff         // - Set a field in object
            } else if (typeof curr_obj === 'string') {  // String
                console.assert(typeof new_stuff === 'string')
                if (!slice_start) {slice_start = slice_end; slice_end = slice_end+1}
                if (last_obj) {
                    var s = last_obj[last_field]
                    last_obj[last_field] = (s.slice(0, slice_start)
                                            + new_stuff
                                            + s.slice(slice_end))
                } else
                    return obj.slice(0, slice_start) + new_stuff + obj.slice(slice_end)
            } else                                     // Array
                if (slice_start)                       //  - Array splice
                    [].splice.apply(curr_obj, [slice_start, slice_end-slice_start]
                                    .concat(new_stuff))
            else {                                     //  - Array set
                console.assert(slice_end >= 0, 'Index '+subpath+' is too small')
                console.assert(slice_end <= curr_obj.length - 1,
                               'Index '+subpath+' is too big')
                curr_obj[slice_end] = new_stuff
            }

            return obj
        }

        // Otherwise, descend down the path
        console.assert(!slice_start, 'No splices allowed in middle of path')
        last_obj = curr_obj
        last_field = field || slice_end
        curr_obj = curr_obj[last_field]
        path = path.substr(subpath.length)
    }
}

braid_text.encode_filename = encode_filename
braid_text.decode_filename = decode_filename

braid_text.dt_get = dt_get
braid_text.dt_get_patches = dt_get_patches
braid_text.dt_parse = dt_parse
braid_text.dt_create_bytes = dt_create_bytes

module.exports = braid_text
