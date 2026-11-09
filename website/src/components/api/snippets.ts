// Request code samples generated from an operation.
export type Op = {
  id: string; method: string; path: string; servers: string[]; summary: string; description: string;
  deprecated: boolean; securityOptional?: boolean;
  security: { name: string; type: string; scheme?: string; in?: string; name_?: string; [k: string]: unknown }[];
  params: Record<'path' | 'query' | 'header' | 'cookie', Param[]>;
  body: null | { required: boolean; contentType: string; description: string; schema: Schema; example: unknown };
  responses: {
    status: string; description: string; contentType: string | null; schema: Schema | null; example: unknown;
    headers?: { name: string; description: string; schema: Schema }[];
    contents?: { contentType: string; schema: Schema | null }[];
  }[];
};
export type Param = { name: string; in: string; required?: boolean; description?: string; schema?: Schema; example?: unknown };
export type Schema = {
  type?: string | string[]; title?: string; format?: string; description?: string; enum?: unknown[]; default?: unknown; example?: unknown;
  properties?: Record<string, Schema>; required?: string[]; items?: Schema; nullable?: boolean;
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number; pattern?: string;
  oneOf?: Schema[]; anyOf?: Schema[]; allOf?: Schema[]; deprecated?: boolean; readOnly?: boolean;
};

function authHeaders(op: Op): [string, string][] {
  const out: [string, string][] = [];
  for (const s of op.security) {
    if (s.type === 'http' && s.scheme === 'bearer') out.push(['Authorization', 'Bearer <token>']);
    else if (s.type === 'http' && s.scheme === 'basic') out.push(['Authorization', 'Basic <encoded-value>']);
    else if (s.type === 'apiKey' && s.in === 'header') out.push([String((s as any).name ?? 'X-API-Key'), '<api-key>']);
  }
  return out;
}

function url(op: Op) {
  const base = (op.servers[0] || '').replace(/\/$/, '');
  const q = op.params.query.filter((p) => p.required || p.example !== undefined || p.schema?.example !== undefined);
  const qs = q.map((p) => `${p.name}=${encodeURIComponent(String(p.example ?? p.schema?.example ?? p.schema?.default ?? `<${p.name}>`))}`).join('&');
  return `${base}${op.path}${qs ? `?${qs}` : ''}`;
}

const isJson = (ct?: string | null) => !!ct && /json/.test(ct);

// How the request body is sent: JSON, a text document (HTML, CSV, ...), or a file's raw bytes.
function bodyKind(op: Op): 'none' | 'json' | 'text' | 'file' {
  if (!op.body) return 'none';
  if (isJson(op.body.contentType)) return 'json';
  if (op.body.schema?.format === 'binary' || !/^text\//.test(op.body.contentType)) return 'file';
  return 'text';
}

function sampleFile(op: Op) {
  const ex = op.body?.example;
  if (typeof ex === 'string' && /^[\w.-]+\.\w+$/.test(ex)) return ex;
  const ct = op.body?.contentType || '';
  return ct.startsWith('text/html') ? 'page.html' : ct === 'application/pdf' ? 'report.pdf' : 'file';
}

export function snippets(op: Op): { label: string; language: string; code: string }[] {
  const headers = authHeaders(op);
  for (const h of op.params.header) {
    const v = h.example ?? h.schema?.example;
    if (h.required || v !== undefined) headers.push([h.name, String(v ?? `<${h.name}>`)]);
  }
  const kind = bodyKind(op);
  if (op.body) headers.push(['Content-Type', op.body.contentType]);
  const body = kind === 'json' ? JSON.stringify(op.body!.example, null, 2) : null;
  const file = kind === 'text' || kind === 'file' ? sampleFile(op) : null;
  const u = url(op);
  const ok = op.responses.find((r) => r.status.startsWith('2'));
  const jsonOut = !ok || isJson(ok.contentType);

  const dataLine = body ? `  --data '${body}'` : file ? `  --data-binary '@${file}'` : null;
  const curl = [`curl --request ${op.method} \\`, `  --url '${u}'${headers.length || dataLine ? ' \\' : ''}`]
    .concat(headers.map(([k, v], i) => `  --header '${k}: ${v}'${i < headers.length - 1 || dataLine ? ' \\' : ''}`))
    .concat(dataLine ? [dataLine] : []).join('\n');

  const pyHeaders = headers.length ? `headers = {\n${headers.map(([k, v]) => `    "${k}": "${v}"`).join(',\n')}\n}\n` : '';
  const pyBody = body ? `payload = ${body}\n` : file ? `with open("${file}", "rb") as f:\n    payload = f.read()\n` : '';
  const pyArg = body ? ', json=payload' : file ? ', data=payload' : '';
  const python = `import requests\n\nurl = "${u}"\n${pyHeaders}${pyBody}\nresponse = requests.${op.method.toLowerCase()}(url${headers.length ? ', headers=headers' : ''}${pyArg})\nprint(${jsonOut ? 'response.json()' : 'response.text'})`;

  const jsHeaders = headers.length ? `  headers: {\n${headers.map(([k, v]) => `    '${k}': '${v}'`).join(',\n')}\n  },\n` : '';
  const jsPre = file ? `import { readFile } from 'node:fs/promises';\n\n` : '';
  const jsBody = body ? `  body: JSON.stringify(${body.replace(/\n/g, '\n  ')}),\n` : file ? `  body: await readFile('${file}'),\n` : '';
  const js = `${jsPre}const response = await fetch('${u}', {\n  method: '${op.method}',\n${jsHeaders}${jsBody}});\nconst data = await response.${jsonOut ? 'json' : 'text'}();\nconsole.log(data);`;

  return [
    { label: 'cURL', language: 'bash', code: curl },
    { label: 'Python', language: 'python', code: python },
    { label: 'JavaScript', language: 'javascript', code: js },
  ];
}
