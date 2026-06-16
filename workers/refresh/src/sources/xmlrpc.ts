// Hand-rolled XML-RPC client for Cloudflare Workers.
// Workers V8 isolate has fetch + Web Crypto, but no Node net/http/Buffer.
// Most npm xmlrpc libraries depend on those. Odoo's XML-RPC is XML over HTTPS POST,
// so we encode the request envelope and use fast-xml-parser to decode the response.

import { XMLParser } from "fast-xml-parser";

// ───────────────────────────────── encode ─────────────────────────────────

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);
}

export function encodeValue(v: unknown): string {
  if (v === null || v === undefined) return "<value><nil/></value>";
  if (typeof v === "string") return `<value><string>${escXml(v)}</string></value>`;
  if (typeof v === "boolean") return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === "number") {
    if (Number.isInteger(v) && v >= -2_147_483_648 && v <= 2_147_483_647) {
      return `<value><int>${v}</int></value>`;
    }
    return `<value><double>${v}</double></value>`;
  }
  if (Array.isArray(v)) {
    return `<value><array><data>${v.map(encodeValue).join("")}</data></array></value>`;
  }
  if (typeof v === "object") {
    const members = Object.entries(v as Record<string, unknown>)
      .map(([k, vv]) => `<member><name>${escXml(k)}</name>${encodeValue(vv)}</member>`)
      .join("");
    return `<value><struct>${members}</struct></value>`;
  }
  throw new Error(`xmlrpc: cannot encode value of type ${typeof v}`);
}

export function methodCall(method: string, params: unknown[]): string {
  const paramElems = params.map((p) => `<param>${encodeValue(p)}</param>`).join("");
  return `<?xml version="1.0"?><methodCall><methodName>${escXml(method)}</methodName><params>${paramElems}</params></methodCall>`;
}

// ───────────────────────────────── decode ─────────────────────────────────

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: false,
  preserveOrder: false,
});

export class XmlRpcFault extends Error {
  constructor(public code: number, public faultString: string) {
    super(`XML-RPC fault ${code}: ${faultString}`);
    this.name = "XmlRpcFault";
  }
}

export function parseResponse(xml: string): unknown {
  const cleaned = xml.replace(/^﻿/, "");
  const parsed = parser.parse(cleaned) as { methodResponse?: any };
  const root = parsed?.methodResponse;
  if (!root) throw new Error("xmlrpc: missing <methodResponse>");

  if (root.fault) {
    const fault = decodeValue(root.fault.value);
    if (fault && typeof fault === "object" && !Array.isArray(fault)) {
      const f = fault as { faultCode?: number; faultString?: string };
      throw new XmlRpcFault(f.faultCode ?? -1, f.faultString ?? "unknown fault");
    }
    throw new XmlRpcFault(-1, JSON.stringify(fault));
  }

  if (!root.params) return null;
  const param = Array.isArray(root.params.param) ? root.params.param[0] : root.params.param;
  if (!param) return null;
  return decodeValue(param.value);
}

function decodeValue(value: any): unknown {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value;

  if (typeof value === "object") {
    if ("string" in value) return String(value.string ?? "");
    if ("int" in value) return Number(value.int);
    if ("i4" in value) return Number(value.i4);
    if ("double" in value) return Number(value.double);
    if ("boolean" in value) return value.boolean === "1" || value.boolean === 1 || value.boolean === true;
    if ("nil" in value) return null;
    if ("dateTime.iso8601" in value) return parseXmlRpcDate(value["dateTime.iso8601"]);
    if ("base64" in value) return value.base64;
    if ("array" in value) return decodeArray(value.array);
    if ("struct" in value) return decodeStruct(value.struct);
    return "";
  }
  return value;
}

function decodeArray(array: any): unknown[] {
  if (!array?.data) return [];
  const inner = array.data.value;
  if (inner == null) return [];
  const arr = Array.isArray(inner) ? inner : [inner];
  return arr.map(decodeValue);
}

function decodeStruct(struct: any): Record<string, unknown> {
  if (!struct?.member) return {};
  const members = Array.isArray(struct.member) ? struct.member : [struct.member];
  const out: Record<string, unknown> = {};
  for (const m of members) {
    const name = String(m.name);
    out[name] = decodeValue(m.value);
  }
  return out;
}

function parseXmlRpcDate(s: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +se!));
}

// ───────────────────────────────── client ─────────────────────────────────

export interface XmlRpcCallOptions {
  url: string;
  method: string;
  params: unknown[];
  fetcher?: typeof fetch;
}

export async function xmlrpcCall<T = unknown>(opts: XmlRpcCallOptions): Promise<T> {
  const body = methodCall(opts.method, opts.params);
  const f = opts.fetcher ?? fetch;
  const res = await f(opts.url, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8" },
    body,
  });
  if (!res.ok) {
    throw new Error(`xmlrpc: HTTP ${res.status} from ${opts.url}`);
  }
  const text = await res.text();
  return parseResponse(text) as T;
}
