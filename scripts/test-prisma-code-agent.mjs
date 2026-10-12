import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("Prisma creates a verified preview without writing to GitHub", { timeout: 45000 }, async () => {
  let writes = 0;
  const fixture = "export const value = 1;\n";
  const mock = http.createServer(async (req, res) => {
    const url = req.url || "";
    res.setHeader("Content-Type", "application/json");
    if (url.includes("/contents/fixture.ts")) {
      if (req.method === "PUT") { writes++; res.end(JSON.stringify({commit:{sha:"test"}})); return; }
      res.end(JSON.stringify({type:"file",encoding:"base64",size:fixture.length,sha:"a".repeat(40),content:Buffer.from(fixture).toString("base64")}));
      return;
    }
    if (url.includes("/chat/completions")) {
      res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({find:"value = 1",replace:"value = 2"})}}]}));
      return;
    }
    res.statusCode = 404; res.end("{}");
  });
  mock.listen(0,"127.0.0.1");
  await once(mock,"listening");
  const fakePort = mock.address().port;
  const portServer = http.createServer();
  portServer.listen(0,"127.0.0.1"); await once(portServer,"listening");
  const appPort=portServer.address().port; portServer.close(); await once(portServer,"close");
  const app=spawn(process.execPath,["prisma/artifacts/api-server/dist/index.mjs"],{
    env:{...process.env,PORT:String(appPort),PRISMA_CODE_ACCESS_TOKEN:"local-test-secret",
      PRISMA_GITHUB_TOKEN:"fake-token",PRISMA_CODE_OWNER:"lgomezpallo",PRISMA_CODE_REPOS:"I.achat.Full",
      PRISMA_GITHUB_API_BASE:`http://127.0.0.1:${fakePort}`,
      AI_ROUTER_BASE_URL:`http://127.0.0.1:${fakePort}/api/v1`,
      AI_ROUTER_API_KEY:"fake-router-token",AI_ROUTER_CHAT_MODEL:"mock-coder",
      PRISMA_CODE_WRITE_ENABLED:"0"},
    stdio:"ignore"
  });
  try {
    let ready=false;
    for(let i=0;i<90;i++){
      if(app.exitCode!==null) throw new Error("Prisma server exited before readiness");
      try {const r=await fetch(`http://127.0.0.1:${appPort}/api/healthz`,{signal:AbortSignal.timeout(500)});if(r.ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.equal(ready,true,"API did not start");
    const response=await fetch(`http://127.0.0.1:${appPort}/api/code-agent/patch`,{
      method:"POST",headers:{"Content-Type":"application/json","X-Prisma-Code-Token":"local-test-secret"},
      body:JSON.stringify({repo:"I.achat.Full",path:"fixture.ts",branch:"prisma/testfix",task:"Cambiar value a 2",apply:false})
    });
    const result=await response.json();
    assert.equal(response.status,200,JSON.stringify(result));
    assert.equal(result.applied,false);
    assert.equal(result.preview,"export const value = 2;\n");
    assert.equal(writes,0,"Preview must never write");
    const denied=await fetch(`http://127.0.0.1:${appPort}/api/code-agent/patch`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({repo:"I.achat.Full",path:"fixture.ts",branch:"prisma/testfix",task:"Cambiar value a 2",apply:false})
    });
    assert.equal(denied.status,403);
  } finally {
    app.kill("SIGTERM");
    await new Promise(resolve=>{ if(app.exitCode!==null || app.signalCode!==null)resolve();else app.once("exit",resolve); });
    mock.close(); await once(mock,"close");
  }
});
