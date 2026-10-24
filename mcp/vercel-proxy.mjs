import http from "node:http";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 3000);
const MCP_HTTP_PORT = Number(process.env.PENPOT_MCP_SERVER_PORT || 4401);
const MCP_WS_PORT = Number(process.env.PENPOT_MCP_WEBSOCKET_PORT || 4402);

const child = spawn(
    process.execPath,
    ["./dist/index.js", "--multi-user"],
    { cwd: new URL("./packages/server/", import.meta.url).pathname, stdio: "inherit", env: process.env }
);

child.on("exit", (code, signal) => {
    console.error(`Penpot MCP process exited (code=${code}, signal=${signal})`);
    process.exit(code ?? 1);
});

function copyUpgradeResponse(upstreamResponse, clientSocket) {
    const statusCode = upstreamResponse.statusCode || 502;
    const statusMessage = upstreamResponse.statusMessage || "Bad Gateway";
    clientSocket.write(`HTTP/${upstreamResponse.httpVersion} ${statusCode} ${statusMessage}\r\n`);
    for (let i = 0; i < upstreamResponse.rawHeaders.length; i += 2) {
        clientSocket.write(`${upstreamResponse.rawHeaders[i]}: ${upstreamResponse.rawHeaders[i + 1]}\r\n`);
    }
    clientSocket.write("\r\n");
}

const proxy = http.createServer((req, res) => {
    if (req.url === "/health" || req.url?.startsWith("/health?")) {
        res.writeHead(child.exitCode === null ? 200 : 503, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: child.exitCode === null, service: "penpot-mcp" }));
        return;
    }

    const upstream = http.request({
        hostname: "127.0.0.1",
        port: MCP_HTTP_PORT,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${MCP_HTTP_PORT}` },
    }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage, upstreamRes.headers);
        upstreamRes.pipe(res);
    });

    upstream.on("error", (error) => {
        console.error("MCP HTTP proxy error:", error.message);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Penpot MCP backend unavailable" }));
    });

    req.pipe(upstream);
});

proxy.on("upgrade", (req, clientSocket, head) => {
    const upstream = http.request({
        hostname: "127.0.0.1",
        port: MCP_WS_PORT,
        path: req.url,
        method: "GET",
        headers: { ...req.headers, host: `127.0.0.1:${MCP_WS_PORT}` },
    });

    upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
        copyUpgradeResponse(upstreamRes, clientSocket);
        if (upstreamHead.length) clientSocket.write(upstreamHead);
        if (head.length) upstreamSocket.write(head);
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
        clientSocket.on("error", () => upstreamSocket.destroy());
        upstreamSocket.on("error", () => clientSocket.destroy());
        clientSocket.on("close", () => upstreamSocket.destroy());
        upstreamSocket.on("close", () => clientSocket.destroy());
    });

    upstream.on("response", (response) => {
        clientSocket.write(`HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || "Bad Gateway"}\r\nConnection: close\r\n\r\n`);
        response.resume();
        clientSocket.destroy();
    });

    upstream.on("error", (error) => {
        console.error("MCP WebSocket proxy error:", error.message);
        clientSocket.destroy();
    });

    upstream.end();
});

proxy.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));

proxy.listen(PORT, "0.0.0.0", () => {
    console.log(`Vercel proxy listening on 0.0.0.0:${PORT}; MCP HTTP :${MCP_HTTP_PORT}; MCP WebSocket :${MCP_WS_PORT}`);
});

function shutdown() {
    proxy.close();
    child.kill("SIGTERM");
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);