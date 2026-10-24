import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 3000);
const MCP_HTTP_PORT = Number(process.env.PENPOT_MCP_SERVER_PORT || 4401);
const MCP_WS_PORT = Number(process.env.PENPOT_MCP_WEBSOCKET_PORT || 4402);
const PLUGIN_DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "packages/plugin/dist");
const PLUGIN_FILE_PATHS = new Map([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/manifest.json", "manifest.json"],
    ["/plugin.js", "plugin.js"],
    ["/index.js", "index.js"],
    ["/icon.jpg", "icon.jpg"],
]);
const PLUGIN_MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
};
const PLUGIN_CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "*",
};

function getPluginAssetPath(pathname) {
    const mapped = PLUGIN_FILE_PATHS.get(pathname);
    if (mapped) return mapped;

    if (pathname.startsWith("/assets/")) {
        const name = pathname.slice("/assets/".length);
        if (name && !name.includes("/") && /^[A-Za-z0-9._-]+$/.test(name)) {
            return path.join("assets", name);
        }
    }

    return null;
}

async function servePluginAsset(req, res, pathname) {
    const relativePath = getPluginAssetPath(pathname);
    if (!relativePath) return false;

    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
        res.writeHead(405, { allow: "GET, HEAD, OPTIONS", ...PLUGIN_CORS_HEADERS });
        res.end();
        return true;
    }

    if (req.method === "OPTIONS") {
        res.writeHead(204, PLUGIN_CORS_HEADERS);
        res.end();
        return true;
    }

    try {
        const assetPath = path.join(PLUGIN_DIST_DIR, relativePath);
        const content = await fs.readFile(assetPath);
        res.writeHead(200, {
            "content-type": PLUGIN_MIME_TYPES[path.extname(assetPath).toLowerCase()] || "application/octet-stream",
            "cache-control": "public, max-age=300",
            "x-content-type-options": "nosniff",
            ...PLUGIN_CORS_HEADERS,
        });
        res.end(req.method === "HEAD" ? undefined : content);
    } catch (error) {
        if (error?.code !== "ENOENT") console.error("Penpot plugin asset error:", error.message);
        res.writeHead(error?.code === "ENOENT" ? 404 : 500, {
            "content-type": "application/json; charset=utf-8",
            ...PLUGIN_CORS_HEADERS,
        });
        res.end(JSON.stringify({ error: error?.code === "ENOENT" ? "Plugin asset not found" : "Plugin asset unavailable" }));
    }

    return true;
}

const child = spawn(
    process.execPath,
    ["./dist/index.js"],
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

const proxy = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;

    if (req.url === "/health" || req.url?.startsWith("/health?")) {
        res.writeHead(child.exitCode === null ? 200 : 503, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: child.exitCode === null, service: "penpot-mcp" }));
        return;
    }

    if (await servePluginAsset(req, res, pathname)) return;

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

function checkPort(port) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
            socket.destroy();
            resolve();
        });
        socket.once("error", (error) => {
            socket.destroy();
            reject(error);
        });
    });
}

async function waitForPort(port, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;

    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Penpot MCP process exited before port ${port} became ready`);
        }

        try {
            await checkPort(port);
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    throw new Error(`Timed out waiting for Penpot MCP port ${port}: ${lastError?.message || "not ready"}`);
}

async function startProxy() {
    try {
        await Promise.all([waitForPort(MCP_HTTP_PORT), waitForPort(MCP_WS_PORT)]);
        if (child.exitCode !== null) {
            throw new Error("Penpot MCP process exited before the proxy became ready");
        }

        proxy.listen(PORT, "0.0.0.0", () => {
            console.log(`Vercel proxy listening on 0.0.0.0:${PORT}; MCP HTTP :${MCP_HTTP_PORT}; MCP WebSocket :${MCP_WS_PORT}`);
        });
    } catch (error) {
        console.error("Penpot MCP startup failed:", error.message);
        child.kill("SIGTERM");
        process.exit(1);
    }
}

startProxy();

function shutdown() {
    proxy.close();
    child.kill("SIGTERM");
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);