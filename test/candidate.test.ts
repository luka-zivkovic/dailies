import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCandidate } from '../src/candidate.js';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      resolve(addr.port);
    });
  });
}

/** Inputs containing every replacement pattern JS interprets in a string replacement. */
const DOLLAR_INPUTS = ['x$$y', 'price $&now', `a$'b`, 'keep $` this'];

describe('command candidate', () => {
  it.each(DOLLAR_INPUTS)('does not corrupt input %j via $-pattern substitution', async (input) => {
    const output = await runCandidate({ type: 'command', template: 'printf %s {input}' }, input);
    expect(output).toBe(input);
  });

  it('substitutes the input into every {input} occurrence intact', async () => {
    const output = await runCandidate(
      { type: 'command', template: 'printf %s%s {input} {input}' },
      'x$$y',
    );
    expect(output).toBe('x$$yx$$y');
  });

  it('handles outputs larger than the 1 MiB default maxBuffer', async () => {
    const bytes = 2 * 1024 * 1024;
    const output = await runCandidate(
      { type: 'command', template: `head -c ${bytes} /dev/zero | tr '\\0' a` },
      'unused',
    );
    expect(output.length).toBe(bytes);
    expect(output.startsWith('aaa')).toBe(true);
  });
});

describe('http candidate', () => {
  let server: Server;
  let url: string;
  /** Per-test handler; defaults to echoing the parsed prompt back as `output`. */
  let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      handler(req, res, await readBody(req));
    });
    const port = await listen(server);
    url = `http://127.0.0.1:${port}/generate`;
  });

  afterAll(() => {
    server.close();
  });

  function candidate(bodyTemplate = '{"prompt": {input}}') {
    return { type: 'http', url, bodyTemplate } as const;
  }

  function echoPrompt(req: IncomingMessage, res: ServerResponse, body: string): void {
    const { prompt } = JSON.parse(body) as { prompt: string };
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ output: prompt }));
  }

  it.each(DOLLAR_INPUTS)('does not corrupt input %j via $-pattern substitution', async (input) => {
    handler = echoPrompt;
    const output = await runCandidate(candidate(), input);
    expect(output).toBe(input);
  });

  it('sends the input JSON-encoded so the request body stays valid JSON', async () => {
    let received = '';
    handler = (req, res, body) => {
      received = body;
      echoPrompt(req, res, body);
    };
    await runCandidate(candidate(), 'x$$y "quoted"');
    expect(JSON.parse(received)).toEqual({ prompt: 'x$$y "quoted"' });
  });

  it('uses the string `output` field of a JSON response', async () => {
    handler = (_req, res) => {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ output: 'from-output-field', other: 1 }));
    };
    expect(await runCandidate(candidate(), 'in')).toBe('from-output-field');
  });

  it('errors clearly when `output` exists but is not a string', async () => {
    handler = (_req, res) => {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ output: 123 }));
    };
    await expect(runCandidate(candidate(), 'in')).rejects.toThrow(
      /"output" field that is not a string \(got number\)/,
    );
  });

  it('errors clearly when `output` exists but is null', async () => {
    handler = (_req, res) => {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ output: null }));
    };
    await expect(runCandidate(candidate(), 'in')).rejects.toThrow(
      /"output" field that is not a string \(got null\)/,
    );
  });

  it('falls back to the raw body for JSON without an `output` key', async () => {
    const body = JSON.stringify({ result: 'no output key' });
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    };
    expect(await runCandidate(candidate(), 'in')).toBe(body);
  });

  it('falls back to the raw body for non-JSON responses', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('plain text output');
    };
    expect(await runCandidate(candidate(), 'in')).toBe('plain text output');
  });
});
