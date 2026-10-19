# 🔌 ZombieCoder Universal Transport Adapter

**একটি প্রসেস · তিনটি ট্রান্সপোর্ট · একটাই MCP টুল রেজিস্ট্রি**

Claude Desktop, Cursor, VS Code, OpenCode, Zed, Windsurf, Continue — সবাই
আলাদা আলাদা protocol চায়। এই অ্যাডাপ্টার সবাইকে **একটাই প্রক্রিয়া** থেকে সামলায়।

---

## চালু করা

```bash
cd /home/sahon/continue/universal-adapter

node index.js                # HTTP + HTTPS + TLS + ক্লায়েন্ট স্ক্যান
node index.js --stdio        # stdio শুধু (ডেস্কটপ ক্লায়েন্ট যেভাবে spawn করে)
node index.js --scan         # ক্লায়েন্ট কনফিগ খুঁজে দেখে (কিছু বদলায় না)
node index.js --register     # ক্লায়েন্ট কনফিগে লিখে দেয় (ব্যাকআপ সহ)
node index.js --verify       # সব transport যাচাই + রিপোর্ট
```

---

## তিনটি ট্রান্সপোর্ট

| ট্রান্সপোর্ট | ঠিকানা | কে ব্যবহার করে |
|-------------|--------|---------------|
| **HTTP** | `http://127.0.0.1:5400/mcp` | লোকাল ক্লায়েন্ট, curl, স্ক্রিপ্ট |
| **HTTPS** | `https://localhost:5443/mcp` | দূর থেকে, টানেল, TLS প্রয়োজনে |
| **stdio** | `node index.js --stdio` | Claude Desktop, Cursor (সাবপ্রোসেস) |

তিনটাই **একই রেজিস্ট্রি** থেকে টুল দেয় — কোনো transport-এ কম-বেশি নেই।

### HTTP সার্ভার ৪ভাবে উত্তর দেয়

কারণ ভিন্ন ক্লায়েন্ট ভিন্ন path বেছে নেয়:

| পদ্ধতি | পথ | কে ব্যবহার করে |
|--------|-----|---------------|
| `POST` | `/mcp` | বেশিরভাগ আধুনিক ক্লায়েন্ট |
| `POST` (SSE চাইলে) | `/mcp` | streamable-http ক্লায়েন্ট |
| `GET` | `/mcp` | SSE স্ট্রিম খোলে রাখে |
| `ANY` | `/sse` | পুরোনো MCP ক্লায়েন্ট |

---

## TLS

| বিষয় | মান |
|-------|-----|
| প্রটোকল | **TLS 1.3** |
| সাইফার | `TLS_AES_256_GCM_SHA384` |
| সার্টিফিকেট | সেলফ-সাইনড, ৯০ দিন বৈধ |
| ফাইল | `~/.zombiecoder/certs/adapter-cert.pem` |
| প্রাইভেট কী | `~/.zombiecoder/certs/adapter-key.pem` (`chmod 600`) |
| ইস্যুয়ার | `C=BD, ST=Barisal, L=Dhaka, O=ZombieCoder` |

openssl CLI ব্যবহার করে তৈরি — কোনো npm নির্ভরতা নেই, ইন্টারনেট লাগে না।

সার্টিফিকেট **স্বয়ংক্রিয়ভাবে** পুনরায় বানানো হয়, যখন:
- ফাইল নেই
- ২৪ ঘণ্টার মধ্যে মেয়াদ শেষ হবে
- hostname বদলেছে

---

## টুল (১৫৫টি)

অ্যাডাপ্টার **নিজের ১০টা** + **মেইন সার্ভার থেকে টানা ১৫২টা** = ১৬২ র
(৭টা কলিডিং বাদ দিয়ে প্রকাশিত **১৫৫টা**)।

### নিজের ১০টা (এখানেই লেখা, স্যান্ডবক্সসহ)

| টুল | কাজ |
|-----|------|
| `adapter_status` | ট্রান্সপোর্ট, টুল ও মেইন সার্ভার লিংকের অবস্থা |
| `system_info` | OS, Node, CPU, মেমরি |
| `list_directory` | ডিরেক্টরি লিস্ট (recursive সহ) |
| `read_file` | টেক্সট ফাইল পড়া |
| `write_file` | টেক্সট ফাইল লেখা |
| `delete_file` | ফাইল মুছা |
| `glob` | প্যাটার্ন দিয়ে ফাইল খোঁজা |
| `grep` | কনটেন্টে রেগুলার এক্সপ্রেশন সার্চ |
| `hash_text` | sha256 হ্যাশ |
| `agent_personas` | এজেন্ট পার্সোনা ও সংবিধান (`personas.js`): পরিচয়, শেয়ার্ড রুল, প্রিন্সিপল, ৬ এজেন্টের রোস্টার — `Args: { id?, section? }` |

### মেইন সার্ভার থেকে টানা ১৫২টা (Pull Sync)

`main-sync.js` মেইন সার্ভারের `tools/list` **টেনে** নেয় (প্রতি ৩০ সেকেন্ডে),
আর `tools/call` হলে সরাসরি মেইন সার্ভারে ফরওয়ার্ড করে। মেইন সার্ভারে
(`api.js`) কোনো পরিবর্তন করতে হয় না।

```
মেইন সার্ভার (5050, ১৫২ টুল)
      ↓ pull (৩০s TTL)
অ্যাডাপ্টার (১০ নিজের + ১৫২ রিমোট − ৭ কলিডিং = ১৫৫)
      ↓ তিনটে transport (HTTP / HTTPS / stdio)
ক্লায়েন্ট
```

| বিষয় | মান |
|-------|-----|
| সোর্স | `http://127.0.0.1:5050/mcp` (env: `MAIN_SERVER_MCP`) |
| TTL | ৩০ সেকেন্ড (env: `MAIN_SYNC_TTL_MS`) |
| টাইমআউট | ২০ সেকেন্ড (env: `MAIN_SYNC_TIMEOUT_MS`) |
| কলিডিং | ৭টা নাম মিলে — **অ্যাডাপ্টারের স্যান্ডবক্সড ভার্সন জেতে** |
| মেইন সার্ভার ডাউন | নিজের ১০টা দেয়, ব্রেক হয় না |

কলিডিং ৭টা: `system_info`, `list_directory`, `read_file`, `write_file`,
`delete_file`, `glob`, `grep`। মেইন সার্ভারের `read_file` কোনো রুট ছোঁয় না
(`/etc/passwd` পড়ে), আর HTTPS ট্রান্সপোর্ট `0.0.0.0`-এ বাইন্ড হয় — তাই
লোকাল সংস্করণই জিতে, রিমোটটা কখনো শ্যাডো করে না।

### নিরাপত্তা — স্যান্ডবক্স

ফাইল টুলগুলো **root বাইরে যেতে পারে না**। বাইরে গেলে ত্রুটি:

```json
{ "error": "path outside allowed roots: /etc/passwd",
  "allowedRoots": ["/home/sahon/continue/universal-adapter"] }
```

root বদলাতে:

```bash
ADAPTER_ROOTS="/home/sahon/z,/home/sahon/Documents" node index.js
```

---

## 🔌 প্লাগইন — universal-bridge

`plugin/index.ts` — OpenCode প্লাগইন যা অ্যাডাপ্টারের **সব টুল** এডিটরে নিয়ে আসে।

### কী করে

1. এন্ডপয়েন্ট ধরে: **লোকাল HTTPS (5443) → লোকাল HTTP (5400) → মেইন সার্ভার**
2. `tools/list` পড়ে প্রতিটি টুল `ua_` প্রিফিক্স দিয়ে রেজিস্টার করে
3. OCR / screen-recorder / TTS কে stdio চাইল্ড হিসেবে spawn করে (`mcp_*`)
4. `adapter_control` ম্যানেজমেন্ট টুল দেয়
5. **মিশন বুটস্ট্র্যাপ:** সেশনের ওয়ার্কিং ডিরেক্টরিতে `.zombiecoder/` লেআউট
   তৈরি করে — `SSOT.md` + `agents/syllabus.md` + `agents/memory.json` + `agents/sessions/`
   (নিচে "মিশন বুটস্ট্র্যাপ" সেকশন)
6. **রানটাইম ইনজেকশন:** context hook দিয়ে প্রতিটি মডেল কলে SSOT + syllabus-এর
   bounded digest ঢোকে সিস্টেম প্রম্পটে; prompt hook দিয়ে প্রতিটি প্রম্পট
   `memory.json` (শেষ ৫টি উইন্ডো) + `memory.archive.json` (append-only ইতিহাস)-এ জমা হয়
7. **সার্ভার অ্যাডপশন:** `set_working_dir` সরাসরি মেইন সার্ভারে (127.0.0.1:5050)
   Bearer টোকেনসহ কল করে — টোকেন রানটাইমে env/`.env` থেকে আসে, কোডে নেই,
   অ্যাডাপ্টার দিয়ে যায় না; প্রয়োজন হলে ১০ মিনিট পরপর drift-healing দিয়ে ডিরেক্টরি ফেরায়

> শুধু **লোকাল অ্যাডাপ্টার চাইলে** সব ১৫৫টা টুল + স্যান্ডবক্স পাওয়া যায়।
> অ্যাডাপ্টার বন্ধ থাকলে প্লাগইন মেইন সার্ভারে পড়ে (১৫২টা টুল, স্যান্ডবক্স ছাড়া)
> এবং কনসোলে সতর্কতা দেখায়।

### রেজিস্ট্রেশন API (`ctx.tool.transform`)

`@opencode/plugin`-এ `Context.tool` হলো `ToolDomain` — তাতে **`add` নেই**।
সঠিক পথ:

```ts
await ctx.tool.transform((editor) => {
  editor.add({ name, description, input, execute })   // ToolEditor-তে add আছে
})
```

`ctx.tool.add(...)` ধরলে OpenCode পুরো প্লাগইন ফেলে দেয়
(`"ctx.tool.add is not a function"` — আগে ৩৪ বার হয়েছিল)।
টেস্টের mock-ও একইভাবে `add` ছাড়া তৈরি, তাই ধরা পড়ে।

### প্লাগইনে যা পাওয়া যায়

```
ua_*             ← ১৫৫টা (অ্যাডাপ্টারের সব টুল)
mcp_ocr_*        ← ৩টা stdio চাইল্ড
mcp_screen-recorder_*  ← ৪টা
mcp_tts_*        ← ৩টা
adapter_control  ← স্ট্যাটাস / টুল / রিফ্রেশ / enable / disable
```

### মিশন বুটস্ট্র্যাপ (প্রতি ওয়ার্কিং ডিরেক্টরি)

আগে OpenCode সেশন কোনো মিশন ফাইল তৈরি করত না — এজেন্টদের কাছে কিছু ছিল না,
মেমরিও জমা হতো না। এখন `setup()` লোকাল ফাইলসিস্টেম দিয়েই সব করে:

```
<working-dir>/.zombiecoder/
├── SSOT.md                    স্টাব (সার্ভার অ্যাডপশনে পূর্ণ স্ক্যানে বদলায়)
├── agents/
│   ├── syllabus.md            অ্যাপেন্ড-অনলি টেবিল (| তারিখ | সোর্স | টপিক |)
│   ├── memory.json            শেষ ৫টি এন্ট্রি (server-compatible ৪ কী)
│   ├── memory.archive.json    পূর্ণ ইতিহাস, JSONL, অ্যাপেন্ড-অনলি
│   └── sessions/
└── …
```

- **Context hook:** প্রতিটি মডেল কলে SSOT (৬০%) + syllabus (৪০%) digest,
  মোট সর্বোচ্চ `UNIVERSAL_MISSION_CONTEXT_CHARS` (ডিফল্ট ৪৫০০ ক্যারেক্টার)।
  কারণ: সার্ভারের পূর্ণ SSOT ~৬৫০ কেবি (~১৬৪k টোকেন) — পুরোটা ঢোকালে
  রিকোয়েস্ট কাটা যায়। `0` দিলে ইনজেকশন বন্ধ।
- **Prompt hook:** প্রতিটি প্রম্পট memory-তে (শেষ ৫টি + আর্কাইভ)। ফাইল
  নষ্ট হলে default দিয়ে পুনর্গঠন — প্রম্পট কখনো হারায় না।
- **সার্ভার অ্যাডপশন:** `set_working_dir` **প্রিভিলেজড** টুল (২০২৬-১০-০৮ থেকে
  `mcpGate` Bearer টোকেন চায়)। অ্যাডাপ্টার টোকেন পাঠায় না (ACAO:* হলে সেটাই RCE),
  তাই প্লাগইন **সরাসরি ১২৭.০.০.১:৫০৫০**-কে কল করে — টোকেন শুধু ওই এক লুপব্যাক
  রিকোয়েস্টে যায়, non-loopback host হলে রিফিউজ করে।
- **Drift-healing:** সার্ভারের `mcpWorkingDir` একটাই বলে একসাথে খোলা একাধিক
  লোকেশন শেষ-লেখা-জেতে (লাইভে প্রমাণিত); সক্রিয় সেশন context hook-এ
  থ্রটলড প্রোব (ডিফল্ট ১০ মিনিট) দিয়ে নিজের ডিরেক্টরি ফেরায় — fire-and-forget,
  মডেল কল কখনো অপেক্ষা করে না।

| এনভারনমেন্ট | ডিফল্ট | কাজ |
|---|---|---|
| `UNIVERSAL_MISSION_CONTEXT_CHARS` | `4500` | digest সীমা; `0` = ইনজেকশন বন্ধ |
| `UNIVERSAL_MISSION_SERVER_SYNC` | চালু | `=0` দিলে `set_working_dir` স্কিপ (টেস্টে ব্যবহৃত) |
| `UNIVERSAL_MAIN_SERVER` | `http://127.0.0.1:5050/mcp` | অ্যাডপশনের লক্ষ্য (শুধু লুপব্যাক অনুমোদিত) |
| `UNIVERSAL_MISSION_READOPT_MS` | `600000` | drift-healing ইন্টারভ্যাল (ms) |

সব ফেল হলেও লোকাল ফাইল + দুই hook স্বাধীনভাবে চলে — প্লাগইন কখনো
OpenCode ভাঙে না।

### সুরক্ষা

অ্যাডাপ্টার বন্ধ থাকলেও প্লাগইন **OpenCode ধাক্ষা করে না** — শুধু সতর্ক করে নিজে চুপ হয়ে যায়।

---

## টেস্ট

```bash
node index.js --verify                     # 3 টেস্ট (EXIT কোড ফেরত দেয়)
node plugin/test-plugin.mjs                # 37 টেস্ট
```

চালানোর আগে অ্যাডাপ্টার চালু থাকা লাগবে (`node index.js`),
কারণ টেস্টটা আসল ব্যাকএন্ডের বিরুদ্ধে চলে।

বর্তমান অবস্থা: **অ্যাডাপ্টার ৩/৩ · প্লাগইন ৩৭/৩৭**

প্লাগইন টেস্ট যা প্রমাণ করে:

- `ctx.tool.transform`-ই একমাত্র রেজিস্ট্রেশন পথ, `ctx.tool.add` নেই
- `ua_agent_mission` / `ua_get_working_dir` → **মেইন সার্ভার টুল অ্যাডাপ্টার দিয়ে আসছে**
- লাইভ ব্যাকএন্ডের `tools/list`-এর সাথে ঠিক মিল (১৫৫, ব্যান্ড ≥১৫০)
- `adapter_control` সব অ্যাকশনই কাজ করে
- `../../../../etc/passwd` স্যান্ডবক্স ব্লক করে
- **মিশন লেআউট:** SSOT/syllabus/memory/sessions তৈরি, memory-তে সার্ভার-সামপাতি
  ৪ কী, syllabus-এর টেবিল মার্কার, রি-রানে বিদ্যমান জ্ঞান মুছে না
- **হুক:** context hook digest ঢোকায় (সীমার মধ্যে), prompt hook এন্ট্রি লেখে,
  উইন্ডো ৫-এ সীমাবদ্ধ, খালি প্রম্পট বাদ, আর্কাইভে ৮/৮ বৈধ JSONL
- **সার্ভার অ্যাডপশন:** `loadAdminToken()` string|null ফেরত দেয়,
  `UNIVERSAL_MISSION_SERVER_SYNC=0` থাকা অবস্থায় আসল সার্ভারে কিছু যায় না,
  টেস্ট-শেষে টেম্প ডিরেক্টরি মুছে যায়

---

## ফাইল

```
universal-adapter/
├── index.js              মূল — তিন transport চালায়
├── registry.js           একটাই MCP টুল রেজিস্ট্রি + JSON-RPC
├── main-sync.js          মেইন সার্ভার থেকে টুল টানে (Pull Sync)
├── transport-http.js     HTTP + HTTPS (একই হ্যান্ডলার)
├── transport-stdio.js    stdio (stdout শুধু প্রোটোকলের জন্য)
├── tls.js                সেলফ-সাইনড সার্টিফিকেট
├── discover.js           ক্লায়েন্ট শোধা + অটো-রেজিস্ট্রেশন
└── plugin/
    ├── index.ts          universal-bridge প্লাগইন
    ├── package.json
    └── test-plugin.mjs   টেস্ট
```

---

## ইন্টিগ্রেশন অবস্থা

| ক্লায়েন্ট | ফাইল | অবস্থা |
|----------|------|--------|
| OpenCode (MCP) | `~/.opencode/opencode.json` → `mcp` | ✅ `zombie-universal` (HTTPS, ১৫২ টুল) |
| OpenCode (প্লাগইন) | `~/.opencode/opencode.json` → `plugins` | ✅ `universal-bridge` — ১৫৫টা `ua_*` + `adapter_control` + মিশন বুটস্ট্র্যাপ/ইনজেকশন |
| VS Code | `~/.config/Code/User/mcp.json` | ✅ `zombie-universal` (stdio) |
| Claude Desktop | — | ফাইল নেই |
| Cursor | — | ফাইল নেই |
| Zed / Windsurf / Continue | — | ফাইল নেই |

সব কনফিগ লেখার আগে `.bak-<timestamp>` ব্যাকআপ তৈরি হয়।

---

**তৈরি:** ZombieCoder Dev Agent · Sahon Srabon · Developer Zone · Dhaka, Bangladesh