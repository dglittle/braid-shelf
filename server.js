
var port = process.argv[2] || 19999

var braid_shelf = require("./index.js")

var server = require("http").createServer(async (req, res) => {
    console.log(`${req.method} ${req.url}`)

    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "*")
    res.setHeader("Access-Control-Allow-Headers", "*")
    res.setHeader("Access-Control-Expose-Headers", "*")

    if (req.method === 'OPTIONS') {
        res.writeHead(200)
        return res.end()
    }

    if (req.url.endsWith("?editor")) {
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" })
        return require("fs").createReadStream("./editor.html").pipe(res)
    }

    if (req.url === '/test-readme') {
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" })
        return require("fs").createReadStream("./test-readme.html").pipe(res)
    }

    if (req.url.startsWith('/test.html')) {
        let parts = req.url.split(/[\?&=]/g)

        if (parts[1] == 'check') {
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" })
            return res.end(JSON.stringify({
                checking: parts[2],
                result: (await braid_shelf.get(parts[2])) != null
            }))
        }

        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" })
        return require("fs").createReadStream("./test.html").pipe(res)        
    }

    braid_shelf.serve(req, res)
})

server.listen(port, () => {
    console.log(`server started on port ${port}`)
})
