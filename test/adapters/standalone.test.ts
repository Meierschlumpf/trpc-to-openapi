import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { TRPCError, initTRPC } from '@trpc/server';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import { Server } from 'http';
import fetch from 'node-fetch';
import superjson from 'superjson';
import { z } from 'zod';

import {
  CreateOpenApiHttpHandlerOptions,
  OpenApiErrorResponse,
  OpenApiMeta,
  OpenApiRouter,
  createOpenApiHttpHandler,
} from '../../src';
import * as zodUtils from '../../src/utils/zod';

// @ts-expect-error - global fetch
global.fetch = fetch;

const createContextMock = jest.fn();
const responseMetaMock = jest.fn();
const onErrorMock = jest.fn();

const clearMocks = () => {
  createContextMock.mockClear();
  responseMetaMock.mockClear();
  onErrorMock.mockClear();
};

let server: Server;

const createHttpServerWithRouter = <TRouter extends OpenApiRouter>(
  handlerOpts: CreateOpenApiHttpHandlerOptions<TRouter>,
) => {
  const openApiHttpHandler = createOpenApiHttpHandler<TRouter>({
    router: handlerOpts.router,
    createContext: handlerOpts.createContext ?? createContextMock,
    responseMeta: handlerOpts.responseMeta ?? responseMetaMock,
    onError: handlerOpts.onError ?? onErrorMock,
    maxBodySize: handlerOpts.maxBodySize,
  } as any);
  const httpHandler = createHTTPHandler<TRouter>({
    router: handlerOpts.router,
    createContext: handlerOpts.createContext ?? createContextMock,
    responseMeta: handlerOpts.responseMeta ?? responseMetaMock,
    onError: handlerOpts.onError ?? onErrorMock,
    maxBodySize: handlerOpts.maxBodySize,
  } as any);

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  server = new Server((req, res) => {
    if (req.url!.startsWith('/trpc')) {
      req.url = req.url!.replace('/trpc', '');
      return httpHandler(req, res);
    }
    return openApiHttpHandler(req, res);
  });

  server.listen(0);
  const port = (server.address() as any).port as number;
  const url = `http://localhost:${port}`;

  return {
    url,
    close: () => server.close(),
  };
};

const t = initTRPC.meta<OpenApiMeta>().context<any>().create();

describe('standalone adapter', () => {
  afterEach(() => {
    clearMocks();
    server?.close();
  });

  // Please note: validating router does not happen in `production`.
  test('with invalid router', () => {
    const appRouter = t.router({
      invalidRoute: t.procedure
        .meta({ openapi: { method: 'GET', path: '/invalid-route' } })
        .input(z.void())
        .query(({ input }) => input),
    });

    expect(() => {
      createOpenApiHttpHandler({
        router: appRouter,
      });
    }).toThrowError('[query.invalidRoute] - Output parser expects a Zod validator');
  });

  test('with not found path', async () => {
    const appRouter = t.router({
      ping: t.procedure
        .meta({ openapi: { method: 'POST', path: '/ping' } })
        .input(z.void())
        .output(z.literal('pong'))
        .mutation(() => 'pong' as const),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    const res = await fetch(`${url}/pingg`, { method: 'POST' });
    const body = (await res.json()) as OpenApiErrorResponse;

    expect(res.status).toBe(404);
    expect(body).toEqual(expect.objectContaining({ message: 'Not found', code: 'NOT_FOUND' }));
    expect(createContextMock).toHaveBeenCalledTimes(0);
    expect(responseMetaMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledTimes(1);
  });

  test('with not found method', async () => {
    const appRouter = t.router({
      ping: t.procedure
        .meta({ openapi: { method: 'POST', path: '/ping' } })
        .input(z.void())
        .output(z.literal('pong'))
        .mutation(() => 'pong' as const),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    const res = await fetch(`${url}/ping`, { method: 'PATCH' });
    const body = (await res.json()) as OpenApiErrorResponse;

    expect(res.status).toBe(404);
    expect(body).toEqual(expect.objectContaining({ message: 'Not found', code: 'NOT_FOUND' }));
    expect(createContextMock).toHaveBeenCalledTimes(0);
    expect(responseMetaMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledTimes(1);
  });

  test('with missing content-type header', async () => {
    const appRouter = t.router({
      echo: t.procedure
        .meta({ openapi: { method: 'POST', path: '/echo' } })
        .input(z.object({ payload: z.string() }))
        .output(z.object({ payload: z.string() }))
        .mutation(({ input }) => ({ payload: input.payload })),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    const res = await fetch(`${url}/echo`, {
      method: 'POST',
      body: JSON.stringify('Lily'),
      headers: { 'Content-Type': 'application/json' },
    });
    const body = (await res.json()) as OpenApiErrorResponse;

    expect(res.status).toBe(400);
    expect(body).toEqual(
      expect.objectContaining({
        message: 'Input validation failed',
        code: 'BAD_REQUEST',
        issues: [
          {
            code: 'invalid_type',
            expected: 'string',
            message: 'Required',
            path: ['payload'],
            received: 'undefined',
          },
        ],
      }),
    );
    expect(createContextMock).toHaveBeenCalledTimes(1);
    expect(responseMetaMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledTimes(1);
  });

  test('with invalid content-type', async () => {
    const appRouter = t.router({
      echo: t.procedure
        .meta({ openapi: { method: 'POST', path: '/echo' } })
        .input(z.object({ payload: z.string() }))
        .output(z.object({ payload: z.string() }))
        .mutation(({ input }) => ({ payload: input.payload })),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    const res = await fetch(`${url}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'non-json-string',
    });
    const body = (await res.json()) as OpenApiErrorResponse;

    expect(res.status).toBe(415);
    expect(body).toEqual(
      expect.objectContaining({
        message: 'Unsupported content-type "text/plain',
        code: 'UNSUPPORTED_MEDIA_TYPE',
      }),
    );
    expect(createContextMock).toHaveBeenCalledTimes(0);
    expect(responseMetaMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledTimes(1);
  });

  test('with missing input', async () => {
    const appRouter = t.router({
      echo: t.procedure
        .meta({ openapi: { method: 'GET', path: '/echo' } })
        .input(z.object({ payload: z.string() }))
        .output(z.object({ payload: z.string() }))
        .query(({ input }) => ({ payload: input.payload })),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    const res = await fetch(`${url}/echo`, { method: 'GET' });
    const body = (await res.json()) as OpenApiErrorResponse;

    expect(res.status).toBe(400);
    expect(body).toEqual(
      expect.objectContaining({
        message: 'Input validation failed',
        code: 'BAD_REQUEST',
        issues: [
          {
            code: 'invalid_type',
            expected: 'string',
            message: 'Required',
            path: ['payload'],
            received: 'undefined',
          },
        ],
      }),
    );
    expect(createContextMock).toHaveBeenCalledTimes(1);
    expect(responseMetaMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledTimes(1);
  });

  test('with wrong input type', async () => {
    const appRouter = t.router({
      echo: t.procedure
        .meta({ openapi: { method: 'POST', path: '/echo' } })
        .input(z.object({ payload: z.string() }))
        .output(z.object({ payload: z.string() }))
        .mutation(({ input }) => ({ payload: input.payload })),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    const res = await fetch(`${url}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: 123 }),
    });
    const body = (await res.json()) as OpenApiErrorResponse;

    expect(res.status).toBe(400);
    expect(body).toEqual(
      expect.objectContaining({
        message: 'Input validation failed',
        code: 'BAD_REQUEST',
        issues: [
          {
            code: 'invalid_type',
            expected: 'string',
            message: 'Expected string, received number',
            path: ['payload'],
            received: 'number',
          },
        ],
      }),
    );
    expect(createContextMock).toHaveBeenCalledTimes(1);
    expect(responseMetaMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledTimes(1);
  });

  test('with bad output', async () => {
    const appRouter = t.router({
      echo: t.procedure
        .meta({ openapi: { method: 'POST', path: '/echo' } })
        .input(z.object({ payload: z.string() }))
        .output(z.object({ payload: z.string() }))
        // @ts-expect-error - fail on purpose
        .mutation(() => 'fail'),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    const res = await fetch(`${url}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: '@Mario' }),
    });
    const body = (await res.json()) as OpenApiErrorResponse;

    expect(res.status).toBe(500);
    expect(body).toEqual(
      expect.objectContaining({
        message: 'Output validation failed',
        code: 'INTERNAL_SERVER_ERROR',
      }),
    );
    expect(createContextMock).toHaveBeenCalledTimes(1);
    expect(responseMetaMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledTimes(1);
  });

  test('with valid routes', async () => {
    const appRouter = t.router({
      sayHelloQuery: t.procedure
        .meta({ openapi: { method: 'GET', path: '/say-hello' } })
        .input(z.object({ name: z.string() }))
        .output(z.object({ greeting: z.string() }))
        .query(({ input }) => ({ greeting: `Hello ${input.name}!` })),
      sayHelloMutation: t.procedure
        .meta({ openapi: { method: 'POST', path: '/say-hello' } })
        .input(z.object({ name: z.string() }))
        .output(z.object({ greeting: z.string() }))
        .mutation(({ input }) => ({ greeting: `Hello ${input.name}!` })),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    {
      const res = await fetch(`${url}/say-hello?name=Lily`, { method: 'GET' });
      const body = (await res.json()) as { greeting: string };

      expect(res.status).toBe(200);
      expect(body).toEqual({ greeting: 'Hello Lily!' });
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);

      clearMocks();
    }
    {
      const res = await fetch(`${url}/say-hello`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Lily' }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ greeting: 'Hello Lily!' });
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);
    }
  });

  test('with void input', async () => {
    const appRouter = t.router({
      pingQuery: t.procedure
        .meta({ openapi: { method: 'GET', path: '/ping' } })
        .input(z.void())
        .output(z.literal('pong'))
        .query(() => 'pong' as const),
      pingMutation: t.procedure
        .meta({ openapi: { method: 'POST', path: '/ping' } })
        .input(z.void())
        .output(z.literal('pong'))
        .mutation(() => 'pong' as const),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    {
      const res = await fetch(`${url}/ping`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual('pong');
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);

      clearMocks();
    }
    {
      const res = await fetch(`${url}/ping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual('pong');
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);
    }
  });

  test('with void output', async () => {
    const appRouter = t.router({
      ping: t.procedure
        .meta({ openapi: { method: 'GET', path: '/ping' } })
        .input(z.object({ ping: z.string() }))
        .output(z.void())
        .query(() => undefined),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    const res = await fetch(`${url}/ping?ping=ping`, { method: 'GET' });
    let body;
    try {
      body = await res.json();
    } catch (e) {
      // do nothing
    }

    expect(res.status).toBe(200);
    expect(body).toEqual(undefined);
    expect(createContextMock).toHaveBeenCalledTimes(1);
    expect(responseMetaMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledTimes(0);
  });

  test('with createContext', async () => {
    interface Context {
      id: 1234567890;
    }

    const t2 = initTRPC.meta<OpenApiMeta>().context<Context>().create();

    const appRouter = t2.router({
      echo: t2.procedure
        .meta({ openapi: { method: 'GET', path: '/echo' } })
        .input(z.object({ payload: z.string() }))
        .output(z.object({ payload: z.string(), context: z.object({ id: z.number() }) }))
        .query(({ input, ctx }) => ({ payload: input.payload, context: ctx })),
    });

    const { url } = createHttpServerWithRouter({
      createContext: (): Context => ({ id: 1234567890 }),
      router: appRouter,
    });

    const res = await fetch(`${url}/echo?payload=Mario`, { method: 'GET' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(
      expect.objectContaining({
        payload: 'Mario',
        context: { id: 1234567890 },
      }),
    );
    expect(responseMetaMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledTimes(0);
  });

  test('with responseMeta', async () => {
    const appRouter = t.router({
      echo: t.procedure
        .meta({ openapi: { method: 'GET', path: '/echo' } })
        .input(z.object({ payload: z.string() }))
        .output(z.object({ payload: z.string() }))
        .query(({ input }) => ({ payload: input.payload })),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
      responseMeta: () => ({ status: 202, headers: { 'x-custom': 'custom header' } }),
    });

    const res = await fetch(`${url}/echo?payload=Mario`, { method: 'GET' });
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(res.headers.get('x-custom')).toBe('custom header');
    expect(body).toEqual({
      payload: 'Mario',
      context: undefined,
    });
    expect(createContextMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledTimes(0);
  });

  test('with skipped transformer', async () => {
    const t2 = initTRPC.meta<OpenApiMeta>().context<any>().create({
      transformer: superjson,
    });

    const appRouter = t2.router({
      echo: t2.procedure
        .meta({ openapi: { method: 'GET', path: '/echo' } })
        .input(z.object({ payload: z.string() }))
        .output(z.object({ payload: z.string() }))
        .query(({ input }) => ({ payload: input.payload })),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    const res = await fetch(`${url}/echo?payload=Mario`, { method: 'GET' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      payload: 'Mario',
    });
    expect(createContextMock).toHaveBeenCalledTimes(1);
    expect(responseMetaMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledTimes(0);
  });

  test('with warmup request', async () => {
    const appRouter = t.router({});

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    const res = await fetch(`${url}/any-endpoint`, { method: 'HEAD' });

    expect(res.status).toBe(204);
    expect(createContextMock).toHaveBeenCalledTimes(0);
    expect(responseMetaMock).toHaveBeenCalledTimes(0);
    expect(onErrorMock).toHaveBeenCalledTimes(0);
  });

  test('with invalid json', async () => {
    const appRouter = t.router({
      echo: t.procedure
        .meta({ openapi: { method: 'POST', path: '/echo' } })
        .input(z.object({ payload: z.string() }))
        .output(z.object({ payload: z.string() }))
        .mutation(({ input }) => ({ payload: input.payload })),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    const res = await fetch(`${url}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // @ts-expect-error - not JSON.stringified
      body: { payload: 'Lily' },
    });
    const body = (await res.json()) as OpenApiErrorResponse;

    expect(res.status).toBe(500);
    expect(body).toEqual(
      expect.objectContaining({
        message: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR',
      }),
    );
    expect(createContextMock).toHaveBeenCalledTimes(0);
    expect(responseMetaMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledTimes(1);
  });

  test('with maxBodySize', async () => {
    const appRouter = t.router({
      echo: t.procedure
        .meta({ openapi: { method: 'POST', path: '/echo' } })
        .input(z.object({ payload: z.string() }))
        .output(z.object({ payload: z.string() }))
        .mutation(({ input }) => ({ payload: input.payload })),
    });

    const requestBody = JSON.stringify({ payload: 'Lily' });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
      maxBodySize: requestBody.length,
    });

    {
      const res = await fetch(`${url}/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({
        payload: 'Lily',
      });
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);

      clearMocks();
    }
    {
      const res = await fetch(`${url}/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: 'Lily!' }),
      });
      const body = (await res.json()) as OpenApiErrorResponse;

      expect(res.status).toBe(413);
      expect(body).toEqual(
        expect.objectContaining({
          message: 'PAYLOAD_TOO_LARGE',
          code: 'PAYLOAD_TOO_LARGE',
        }),
      );
      expect(createContextMock).toHaveBeenCalledTimes(0);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(1);
    }
  });

  test('with multiple input query string params', async () => {
    const appRouter = t.router({
      sayHello: t.procedure
        .meta({ openapi: { method: 'GET', path: '/say-hello' } })
        .input(z.object({ name: z.string() }))
        .output(z.object({ greeting: z.string() }))
        .query(({ input }) => ({ greeting: `Hello ${input.name}!` })),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    {
      const res = await fetch(`${url}/say-hello?name=Lily&name=Mario`, { method: 'GET' });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body).toEqual(
        expect.objectContaining({
          message: 'Input validation failed',
          code: 'BAD_REQUEST',
          issues: [
            {
              code: 'invalid_type',
              expected: 'string',
              message: 'Expected string, received array',
              path: ['name'],
              received: 'array',
            },
          ],
        }),
      );
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(1);
    }
  });

  test('with array input query string params', async () => {
    const appRouter = t.router({
      sayHello: t.procedure
        .meta({ openapi: { method: 'GET', path: '/say-hello' } })
        .input(z.object({ name: z.array(z.string()) }))
        .output(z.object({ greeting: z.string() }))
        .query(({ input }) => ({ greeting: `Hello ${input.name.join(', ')}!` })),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    {
      const res = await fetch(`${url}/say-hello?name=Lily&name=Mario`, { method: 'GET' });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ greeting: 'Hello Lily, Mario!' });
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);
    }
  });

  test('with case insensitivity', async () => {
    const appRouter = t.router({
      allLowerPath: t.procedure
        .meta({ openapi: { method: 'GET', path: '/lower' } })
        .input(z.object({ name: z.string() }))
        .output(z.object({ greeting: z.string() }))
        .query(({ input }) => ({ greeting: `Hello ${input.name}!` })),
      allUpperPath: t.procedure
        .meta({ openapi: { method: 'GET', path: '/UPPER' } })
        .input(z.object({ name: z.string() }))
        .output(z.object({ greeting: z.string() }))
        .query(({ input }) => ({ greeting: `Hello ${input.name}!` })),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    {
      const res = await fetch(`${url}/LOWER?name=Lily`, { method: 'GET' });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ greeting: 'Hello Lily!' });
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);

      clearMocks();
    }
    {
      const res = await fetch(`${url}/upper?name=Lily`, { method: 'GET' });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ greeting: 'Hello Lily!' });
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);
    }
  });

  test('with path parameters', async () => {
    const appRouter = t.router({
      sayHelloQuery: t.procedure
        .meta({ openapi: { method: 'GET', path: '/say-hello/{name}' } })
        .input(z.object({ name: z.string() }))
        .output(z.object({ greeting: z.string() }))
        .query(({ input }) => ({ greeting: `Hello ${input.name}!` })),
      sayHelloMutation: t.procedure
        .meta({ openapi: { method: 'POST', path: '/say-hello/{name}' } })
        .input(z.object({ name: z.string() }))
        .output(z.object({ greeting: z.string() }))
        .mutation(({ input }) => ({ greeting: `Hello ${input.name}!` })),
      sayHelloComplex: t.procedure
        .meta({ openapi: { method: 'GET', path: '/say-hello/{first}/{last}' } })
        .input(
          z.object({
            first: z.string(),
            last: z.string(),
            greeting: z.string(),
          }),
        )
        .output(z.object({ greeting: z.string() }))
        .query(({ input }) => ({
          greeting: `${input.greeting} ${input.first} ${input.last}!`,
        })),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    {
      const res = await fetch(`${url}/say-hello/Lily`, { method: 'GET' });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ greeting: 'Hello Lily!' });
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);

      clearMocks();
    }
    {
      const res = await fetch(`${url}/say-hello/Lily`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Mario' }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ greeting: 'Hello Lily!' });
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);

      clearMocks();
    }
    {
      const res = await fetch(`${url}/say-hello/Lily/Rose?greeting=Hello&first=Mario`, {
        method: 'GET',
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ greeting: 'Hello Lily Rose!' });
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);
    }
  });

  test('with bad output', async () => {
    const appRouter = t.router({
      badOutput: t.procedure
        .meta({ openapi: { method: 'GET', path: '/bad-output' } })
        .input(z.void())
        .output(z.string())
        // @ts-expect-error - intentional bad output
        .query(() => ({})),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    const res = await fetch(`${url}/bad-output`, { method: 'GET' });
    const body = (await res.json()) as OpenApiErrorResponse;

    expect(res.status).toBe(500);
    expect(body).toEqual(
      expect.objectContaining({
        message: 'Output validation failed',
        code: 'INTERNAL_SERVER_ERROR',
      }),
    );
    expect(createContextMock).toHaveBeenCalledTimes(1);
    expect(responseMetaMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledTimes(1);
  });

  test('with void and trpc client', async () => {
    // ensure monkey patch doesnt break router
    const appRouter = t.router({
      withVoidQuery: t.procedure
        .meta({ openapi: { method: 'GET', path: '/with-void' } })
        .input(z.void())
        .output(z.object({ payload: z.any() }))
        .query(({ input }) => ({ payload: input })),
      withVoidMutation: t.procedure
        .meta({ openapi: { method: 'POST', path: '/with-void' } })
        .input(z.void())
        .output(z.object({ payload: z.any() }))
        .mutation(({ input }) => ({ payload: input })),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    type AppRouter = typeof appRouter;
    const client = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `${url}/trpc` })],
    });

    {
      const res = await client.withVoidQuery.query();

      expect(res).toEqual({});
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);

      clearMocks();

      await expect(() => {
        // @ts-expect-error - send monkey patched input type
        return client.withVoidQuery.query({});
      }).rejects.toThrowErrorMatchingInlineSnapshot(`
      "[
        {
          \\"code\\": \\"invalid_type\\",
          \\"expected\\": \\"void\\",
          \\"received\\": \\"object\\",
          \\"path\\": [],
          \\"message\\": \\"Expected void, received object\\"
        }
      ]"
      `);
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(1);

      clearMocks();
    }
    {
      const res = await client.withVoidMutation.mutate();

      expect(res).toEqual({});
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);

      clearMocks();

      await expect(() => {
        // @ts-expect-error - send monkey patched input type
        return client.withVoidMutation.mutate({});
      }).rejects.toThrowErrorMatchingInlineSnapshot(`
        "[
          {
            \\"code\\": \\"invalid_type\\",
            \\"expected\\": \\"void\\",
            \\"received\\": \\"object\\",
            \\"path\\": [],
            \\"message\\": \\"Expected void, received object\\"
          }
        ]"
      `);
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(1);
    }
  });

  test('with DELETE mutation', async () => {
    const appRouter = t.router({
      echoDelete: t.procedure
        .meta({ openapi: { method: 'DELETE', path: '/echo-delete' } })
        .input(z.object({ payload: z.string() }))
        .output(z.object({ payload: z.string() }))
        .mutation(({ input }) => input),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    const res = await fetch(`${url}/echo-delete?payload=Mario`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ payload: 'Mario' });
    expect(createContextMock).toHaveBeenCalledTimes(1);
    expect(responseMetaMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledTimes(0);
  });

  test('with POST query', async () => {
    const appRouter = t.router({
      echoPost: t.procedure
        .meta({ openapi: { method: 'POST', path: '/echo-post' } })
        .input(z.object({ payload: z.string() }))
        .output(z.object({ payload: z.string() }))
        .query(({ input }) => input),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    const res = await fetch(`${url}/echo-post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: 'Mario' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ payload: 'Mario' });
    expect(createContextMock).toHaveBeenCalledTimes(1);
    expect(responseMetaMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledTimes(0);
  });

  test('with thrown error', async () => {
    const appRouter = t.router({
      customError: t.procedure
        .meta({ openapi: { method: 'POST', path: '/custom-error' } })
        .input(z.void())
        .output(z.void())
        .mutation(() => {
          throw new Error('Custom error message');
        }),
      customTRPCError: t.procedure
        .meta({ openapi: { method: 'POST', path: '/custom-trpc-error' } })
        .input(z.void())
        .output(z.void())
        .mutation(() => {
          throw new TRPCError({
            message: 'Custom TRPCError message',
            code: 'CLIENT_CLOSED_REQUEST',
          });
        }),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    {
      const res = await fetch(`${url}/custom-error`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = (await res.json()) as OpenApiErrorResponse;

      expect(res.status).toBe(500);
      expect(body).toEqual(
        expect.objectContaining({
          message: 'Custom error message',
          code: 'INTERNAL_SERVER_ERROR',
        }),
      );
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(1);

      clearMocks();
    }
    {
      const res = await fetch(`${url}/custom-trpc-error`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = (await res.json()) as OpenApiErrorResponse;

      expect(res.status).toBe(499);
      expect(body).toEqual(
        expect.objectContaining({
          message: 'Custom TRPCError message',
          code: 'CLIENT_CLOSED_REQUEST',
        }),
      );
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(1);
    }
  });

  test('with error formatter', async () => {
    const errorFormatterMock = jest.fn();

    const t2 = initTRPC
      .meta<OpenApiMeta>()
      .context<any>()
      .create({
        errorFormatter: ({ error, shape }) => {
          errorFormatterMock();
          if (error.code === 'INTERNAL_SERVER_ERROR') {
            return { ...shape, message: 'Custom formatted error message' };
          }
          return shape;
        },
      });

    const appRouter = t2.router({
      customFormattedError: t2.procedure
        .meta({ openapi: { method: 'POST', path: '/custom-formatted-error' } })
        .input(z.void())
        .output(z.void())
        .mutation(() => {
          throw new Error('Custom error message');
        }),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    const res = await fetch(`${url}/custom-formatted-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const body = (await res.json()) as OpenApiErrorResponse;

    expect(res.status).toBe(500);
    expect(body).toEqual(
      expect.objectContaining({
        message: 'Custom formatted error message',
        code: 'INTERNAL_SERVER_ERROR',
      }),
    );
    expect(errorFormatterMock).toHaveBeenCalledTimes(1);
    expect(createContextMock).toHaveBeenCalledTimes(1);
    expect(responseMetaMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledTimes(1);
  });

  test('with nested routers', async () => {
    const appRouter = t.router({
      procedure: t.procedure
        .meta({ openapi: { method: 'GET', path: '/procedure' } })
        .input(z.object({ payload: z.string() }))
        .output(z.object({ payload: z.string() }))
        .query(({ input }) => ({ payload: input.payload })),
      router: t.router({
        procedure: t.procedure
          .meta({ openapi: { method: 'GET', path: '/router/procedure' } })
          .input(z.object({ payload: z.string() }))
          .output(z.object({ payload: z.string() }))
          .query(({ input }) => ({ payload: input.payload })),
        router: t.router({
          procedure: t.procedure
            .meta({ openapi: { method: 'GET', path: '/router/router/procedure' } })
            .input(z.object({ payload: z.string() }))
            .output(z.object({ payload: z.string() }))
            .query(({ input }) => ({ payload: input.payload })),
        }),
      }),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    {
      const res = await fetch(`${url}/procedure?payload=one`, { method: 'GET' });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ payload: 'one' });
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);

      clearMocks();
    }
    {
      const res = await fetch(`${url}/router/procedure?payload=two`, { method: 'GET' });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ payload: 'two' });
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);

      clearMocks();
    }
    {
      const res = await fetch(`${url}/router/router/procedure?payload=three`, { method: 'GET' });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ payload: 'three' });
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);
    }
  });

  test('with multiple inputs', async () => {
    const appRouter = t.router({
      multiInput: t.procedure
        .meta({ openapi: { method: 'GET', path: '/multi-input' } })
        .input(z.object({ firstName: z.string() }))
        .input(z.object({ lastName: z.string() }))
        .output(z.object({ fullName: z.string() }))
        .query(({ input }) => ({ fullName: `${input.firstName} ${input.lastName}` })),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    const res = await fetch(`${url}/multi-input?firstName=Lily&lastName=Rose`, { method: 'GET' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ fullName: 'Lily Rose' });
    expect(createContextMock).toHaveBeenCalledTimes(1);
    expect(responseMetaMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledTimes(0);
  });

  test('with preprocess', async () => {
    const appRouter = t.router({
      preprocess: t.procedure
        .meta({ openapi: { method: 'GET', path: '/preprocess' } })
        .input(
          z.object({
            value: z.preprocess((arg) => [arg, arg], z.array(z.string())),
          }),
        )
        .output(z.object({ result: z.string() }))
        .query(({ input }) => ({ result: input.value.join('XXX') })),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    const res = await fetch(`${url}/preprocess?value=lol`, { method: 'GET' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ result: 'lolXXXlol' });
    expect(createContextMock).toHaveBeenCalledTimes(1);
    expect(responseMetaMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledTimes(0);
  });

  test('with non-coerce preprocess', async () => {
    // only applies when zod does not support (below version v3.20.0)

    // @ts-expect-error - hack to disable zodSupportsCoerce
    zodUtils.zodSupportsCoerce = false;
    {
      const appRouter = t.router({
        plusOne: t.procedure
          .meta({ openapi: { method: 'GET', path: '/plus-one' } })
          .input(
            z.object({
              number: z.preprocess(
                (arg) => (typeof arg === 'string' ? parseInt(arg) : arg),
                z.number(),
              ),
            }),
          )
          .output(z.object({ result: z.number() }))
          .query(({ input }) => ({ result: input.number + 1 })),
      });

      const { url } = createHttpServerWithRouter({
        router: appRouter,
      });

      const res = await fetch(`${url}/plus-one?number=9`, { method: 'GET' });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ result: 10 });
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);
    }
    // @ts-expect-error - hack to re-enable zodSupportsCoerce
    zodUtils.zodSupportsCoerce = true;
  });

  test('with coerce', async () => {
    const appRouter = t.router({
      getPlusOne: t.procedure
        .meta({ openapi: { method: 'GET', path: '/plus-one' } })
        .input(z.object({ number: z.number() }))
        .output(z.object({ result: z.number() }))
        .query(({ input }) => ({ result: input.number + 1 })),
      postPlusOne: t.procedure
        .meta({ openapi: { method: 'POST', path: '/plus-one' } })
        .input(z.object({ date: z.date() }))
        .output(z.object({ result: z.number() }))
        .mutation(({ input }) => ({ result: input.date.getTime() + 1 })),
      pathPlusOne: t.procedure
        .meta({ openapi: { method: 'GET', path: '/plus-one/{number}' } })
        .input(z.object({ number: z.number() }))
        .output(z.object({ result: z.number() }))
        .query(({ input }) => ({ result: input.number + 1 })),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    {
      const res = await fetch(`${url}/plus-one?number=9`, { method: 'GET' });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ result: 10 });
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);

      clearMocks();
    }
    {
      const date = new Date();

      const res = await fetch(`${url}/plus-one`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ result: date.getTime() + 1 });
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);

      clearMocks();
    }

    {
      const res = await fetch(`${url}/plus-one/9`, { method: 'GET' });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ result: 10 });
      expect(createContextMock).toHaveBeenCalledTimes(1);
      expect(responseMetaMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledTimes(0);
    }
  });

  test('with x-www-form-urlencoded', async () => {
    const appRouter = t.router({
      echo: t.procedure
        .meta({
          openapi: {
            method: 'POST',
            path: '/echo',
            contentTypes: ['application/x-www-form-urlencoded'],
          },
        })
        .input(z.object({ payload: z.array(z.string()) }))
        .output(z.object({ result: z.string() }))
        .query(({ input }) => ({ result: input.payload.join(' ') })),
    });

    const { url } = createHttpServerWithRouter({
      router: appRouter,
    });

    const res = await fetch(`${url}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'payload=Hello&payload=World',
    });
    const body = await res.json();

    expect(res.status).toBe(415);
    expect(body).toEqual(expect.objectContaining({ code: 'UNSUPPORTED_MEDIA_TYPE' }));
    expect(createContextMock).toHaveBeenCalledTimes(0);
    expect(responseMetaMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledTimes(1);
  });
});
