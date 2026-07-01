import http2 from "node:http2";
import { handleGetChatMessage } from "./handlers/chat.js";
import { shouldInterceptByokChat } from "./handlers/byok-slots.js";
import { getProviderConfig, getRuntimeConfig, setRuntimeConfig } from "./handlers/models.js";
import { getLoopbackListenHosts, loopbackApiUrl } from "./net-utils.js";
import { sanitizeUpstreamResponseHeaders, writeConnectStreamErrorHttp2, streamHeadersHttp2 } from "./connect.js";
function parsePortEnv(arg0, arg1) {
  const tmp2 = process.env[arg0];
  const tmp3 = parseInt(String(tmp2 ?? ""), 10);
  if (Number.isInteger(tmp3) && tmp3 > 0 && tmp3 <= 65535) {
    return tmp3;
  } else {
    return arg1;
  }
}
const PORT = parsePortEnv("INFERENCE_PORT", 3001);
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";
const UPSTREAM = "inference.codeium.com";
const INTERCEPT_PATHS = new Set(["/exa.api_server_pb.ApiServerService/GetChatMessage", "/exa.api_server_pb.ApiServerService/GetCompletions"]);
const STREAMING_PATHS = INTERCEPT_PATHS;
let reqCount = 0;
let upstreamSession = null;
const HOP_BY_HOP_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
function now() {
  return new Date().toISOString().slice(11, 23);
}
function getUpstreamSession() {
  if (upstreamSession && !upstreamSession.destroyed && !upstreamSession.closed) {
    return upstreamSession;
  }
  upstreamSession = http2.connect("https://" + UPSTREAM);
  upstreamSession.on("error", arg0 => {
    console.error("[" + now() + "] inference upstream session error: " + arg0.message);
  });
  upstreamSession.on("close", () => {
    upstreamSession = null;
  });
  return upstreamSession;
}
function toHttp2ResponseHeaders(arg0, tmp1 = {}) {
  const tmp2 = {
    ":status": arg0
  };
  const tmp3 = tmp2;
  for (const [tmp02, tmp12] of Object.entries(tmp1)) {
    const tmp03 = tmp02.toLowerCase();
    if (HOP_BY_HOP_RESPONSE_HEADERS.has(tmp03) || tmp03.startsWith(":")) {
      continue;
    }
    tmp3[tmp03] = tmp12;
  }
  return tmp3;
}
function respondJson(arg0, arg1, arg2) {
  if (arg0.destroyed) {
    return;
  }
  const tmp3 = JSON.stringify(arg2, null, 2);
  try {
    arg0.respond({
      ":status": arg1,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(tmp3)
    });
    arg0.end(tmp3);
  } catch {}
}
function handleRuntimeConfigStream(arg0, arg1) {
  const tmp2 = arg1[":method"] || "GET";
  if (tmp2 === "GET") {
    const tmp02 = getProviderConfig();
    const tmp1 = {
      host: tmp02.anthropic.host,
      hasKey: !!tmp02.anthropic.apiKey
    };
    const tmp22 = {
      host: tmp02.openai.host,
      hasKey: !!tmp02.openai.apiKey
    };
    const tmp32 = {
      anthropic: tmp1,
      openai: tmp22
    };
    respondJson(arg0, 200, {
      ...getRuntimeConfig(),
      providers: tmp32
    });
    return;
  }
  if (tmp2 !== "POST") {
    respondJson(arg0, 405, {
      error: "Method not allowed"
    });
    return;
  }
  const tmp3 = [];
  let tmp4 = 0;
  let tmp5 = false;
  const tmp6 = 16384;
  arg0.on("data", arg02 => {
    if (tmp5) {
      return;
    }
    tmp4 += arg02.length;
    if (tmp4 > tmp6) {
      tmp5 = true;
      const tmp02 = {
        error: "Body too large (max " + tmp6 + " bytes)"
      };
      respondJson(arg0, 413, tmp02);
      arg0.close();
      return;
    }
    tmp3.push(arg02);
  });
  arg0.on("end", () => {
    if (tmp5) {
      return;
    }
    try {
      const tmp02 = JSON.parse(Buffer.concat(tmp3).toString("utf8") || "{}");
      const tmp1 = setRuntimeConfig(tmp02);
      console.log("[" + now() + "] inference config updated: model=" + tmp1.defaultModel + ", maxTokens=" + tmp1.maxTokens);
      respondJson(arg0, 200, tmp1);
    } catch (tmp02) {
      const tmp1 = {
        error: "Invalid JSON: " + tmp02.message
      };
      respondJson(arg0, 400, tmp1);
    }
  });
  arg0.on("error", arg02 => {
    if (arg02.code === "ERR_HTTP2_STREAM_ERROR") {
      return;
    }
    console.error("[" + now() + "] config stream error: " + arg02.message);
  });
}
function forwardToCodeium(arg0, arg1, arg2, arg3, arg4) {
  const tmp5 = STREAMING_PATHS.has(arg3);
  const tmp6 = {};
  for (const [tmp02, tmp1] of Object.entries(arg2)) {
    if (tmp02.startsWith(":") || tmp02 === "host") {
      continue;
    }
    tmp6[tmp02] = tmp1;
  }
  tmp6["content-length"] = arg0.length;
  let tmp7 = false;
  let tmp8;
  try {
    tmp8 = getUpstreamSession().request({
      ":method": "POST",
      ":path": arg3,
      ":authority": UPSTREAM,
      ...tmp6
    });
  } catch (tmp02) {
    console.error("  [#" + arg4 + "] ❌ upstream error: " + tmp02.message);
    if (tmp5) {
      writeConnectStreamErrorHttp2(arg1, "unavailable", "Upstream error: " + tmp02.message, toHttp2ResponseHeaders);
    } else if (!arg1.destroyed) {
      try {
        arg1.respond({
          ":status": 502
        });
        arg1.end();
      } catch {}
    }
    return;
  }
  tmp8.on("response", arg02 => {
    tmp7 = true;
    const tmp1 = {
      ":status": arg02[":status"]
    };
    const tmp2 = tmp1;
    for (const [tmp03, tmp12] of Object.entries(arg02)) {
      if (tmp03.startsWith(":")) {
        continue;
      }
      tmp2[tmp03] = tmp12;
    }
    const tmp3 = sanitizeUpstreamResponseHeaders(tmp2, tmp5);
    if (!arg1.destroyed) {
      try {
        arg1.respond(tmp3);
      } catch {}
    }
  });
  tmp8.on("data", arg02 => {
    if (!arg1.destroyed) {
      try {
        arg1.write(arg02);
      } catch {}
    }
  });
  tmp8.on("end", () => {
    if (!arg1.destroyed) {
      arg1.end();
    }
    console.log("  [#" + arg4 + "] ✅ forwarded (h2" + (tmp5 ? " stream" : "") + ")");
  });
  tmp8.on("error", arg02 => {
    console.error("  [#" + arg4 + "] ❌ upstream error: " + arg02.message);
    if (!arg1.destroyed) {
      if (!tmp7 && tmp5) {
        writeConnectStreamErrorHttp2(arg1, "unavailable", "Upstream error: " + arg02.message, toHttp2ResponseHeaders);
      } else {
        try {
          arg1.end();
        } catch {}
      }
    }
  });
  arg1.on("close", () => {
    if (!tmp8.destroyed) {
      tmp8.close();
    }
  });
  tmp8.end(arg0);
}
function buildFakeReqRes(arg0, arg1) {
  const tmp2 = {
    ...arg1
  };
  const tmp3 = {
    headers: tmp2,
    url: arg1[":path"] || "/",
    method: arg1[":method"] || "POST"
  };
  const tmp4 = tmp3;
  let tmp5 = false;
  const tmp6 = {
    headersSent: false,
    writableEnded: false,
    writeHead(tmp02, tmp1 = {}) {
      if (tmp5) {
        return;
      }
      tmp5 = true;
      this.headersSent = true;
      const tmp22 = toHttp2ResponseHeaders(tmp02, sanitizeUpstreamResponseHeaders(tmp1, true));
      try {
        arg0.respond(tmp22);
      } catch {}
    },
    write(tmp02) {
      if (!tmp5) {
        this.writeHead(200, streamHeadersHttp2());
      }
      if (!arg0.destroyed) {
        try {
          arg0.write(tmp02);
        } catch {}
      }
    },
    end(tmp02) {
      if (!tmp5) {
        this.writeHead(200, streamHeadersHttp2());
      }
      this.writableEnded = true;
      if (!arg0.destroyed) {
        try {
          arg0.end(tmp02);
        } catch {}
      }
    },
    on(tmp02, tmp1) {
      if (tmp02 === "close") {
        arg0.on("close", tmp1);
      }
    }
  };
  const tmp7 = {
    fakeReq: tmp4,
    fakeRes: tmp6
  };
  return tmp7;
}
function adaptStreamForHandler(arg0, arg1, arg2) {
  const {
    fakeReq: tmp4,
    fakeRes: tmp5
  } = buildFakeReqRes(arg1, arg2);
  handleGetChatMessage(tmp4, tmp5, arg0);
}
const server = http2.createServer();
function attachInferenceStreamHandler(arg0) {
  arg0.on("stream", (arg02, arg1) => {
    const tmp2 = ++reqCount;
    const tmp3 = arg1[":method"] || "GET";
    const tmp4 = arg1[":path"] || "/";
    const tmp5 = arg1["content-type"] || "";
    const tmp6 = tmp4.split("/").pop();
    if (tmp4 === "/api/config") {
      handleRuntimeConfigStream(arg02, arg1);
      return;
    }
    if (tmp3 !== "POST" || !tmp5.includes("connect+proto")) {
      arg02.respond({
        ":status": 404
      });
      arg02.end();
      return;
    }
    const tmp7 = [];
    arg02.on("data", arg03 => tmp7.push(arg03));
    arg02.on("end", () => {
      const tmp02 = Buffer.concat(tmp7);
      console.log("[" + now() + "] #" + tmp2 + " " + tmp6 + " (" + tmp02.length + "b)");
      if (tmp4 === "/exa.api_server_pb.ApiServerService/GetChatMessage" && shouldInterceptByokChat(tmp02, arg1)) {
        console.log("  ⚡ → BYOK (inline chat)");
        try {
          adaptStreamForHandler(tmp02, arg02, arg1);
        } catch (tmp04) {
          console.error("  ❌ Handler error: " + tmp04.message);
          if (!arg02.destroyed) {
            arg02.respond({
              ":status": 500,
              "content-type": "application/json"
            });
            const tmp05 = {
              code: "internal",
              message: tmp04.message
            };
            arg02.end(JSON.stringify(tmp05));
          }
        }
      } else if (INTERCEPT_PATHS.has(tmp4)) {
        console.log("  → " + UPSTREAM + tmp4);
        forwardToCodeium(tmp02, arg02, arg1, tmp4, tmp2);
      } else {
        console.log("  → " + UPSTREAM + tmp4);
        forwardToCodeium(tmp02, arg02, arg1, tmp4, tmp2);
      }
    });
    arg02.on("error", arg03 => {
      if (arg03.code === "ERR_HTTP2_STREAM_ERROR") {
        return;
      }
      console.error("[" + now() + "] #" + tmp2 + " stream error: " + arg03.message);
    });
  });
}
attachInferenceStreamHandler(server);
function onInferenceError(arg0) {
  if (arg0.code === "EADDRINUSE") {
    console.error("Port " + PORT + " in use. Kill existing: lsof -ti:" + PORT + " | xargs kill");
  } else {
    console.error("Server error:", arg0);
  }
  process.exit(1);
}
function printInferenceReady() {
  const tmp02 = getLoopbackListenHosts(BIND_HOST);
  console.log("\n⚡ Devin BYOK Bridge inference on " + loopbackApiUrl(PORT));
  console.log("   Bind hosts: " + tmp02.join(", "));
  console.log("\n   GetChatMessage (BYOK models) → your API key / gateway");
  console.log("   GetCompletions / other chat   → " + UPSTREAM);
  console.log("   Everything else               → " + UPSTREAM + "\n");
}
const tmp0 = getLoopbackListenHosts(BIND_HOST);
if (tmp0.length === 1) {
  server.listen(PORT, tmp0[0], printInferenceReady);
  server.on("error", onInferenceError);
} else {
  server.listen(PORT, tmp0[0], () => {});
  server.on("error", onInferenceError);
  const serverV6 = http2.createServer();
  attachInferenceStreamHandler(serverV6);
  serverV6.listen(PORT, tmp0[1], printInferenceReady);
  serverV6.on("error", onInferenceError);
}
