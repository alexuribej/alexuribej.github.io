import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractImageUrl,
  extractVisibleText,
  getPrompt,
  validateProductPayload,
  validatePublicUrl,
} from './worker-script.js';
import worker from './worker-script.js';

const validProduct = {
  nombre: 'Producto X',
  marca: 'Marca',
  condicion: 'Nuevo',
  descripcion: 'Descripción',
  tipo: 'Monitor',
  specs_rapidos: { Resolución: '4K', Puertos: 'HDMI' },
  secciones: [
    {
      titulo: 'Pantalla',
      color: 's1',
      filas: [{ campo: 'Resolución', valor: '3840 x 2160' }],
    },
  ],
};

test('combina todos los mensajes de usuario', () => {
  assert.equal(
    getPrompt({
      messages: [
        { role: 'system', content: 'ignorar' },
        { role: 'user', content: 'primero' },
        { role: 'user', content: [{ type: 'text', text: 'segundo' }] },
      ],
    }),
    'primero\n\nsegundo',
  );
});

test('rechaza protocolos y hosts privados', () => {
  assert.throws(() => validatePublicUrl('file:///etc/passwd'), /URL no válida/);
  assert.throws(() => validatePublicUrl('http://127.0.0.1/producto'), /URL no válida/);
  assert.throws(() => validatePublicUrl('http://192.168.1.20/producto'), /URL no válida/);
  assert.equal(validatePublicUrl('https://example.com/producto').hostname, 'example.com');
});

test('extrae texto visible e imagen absoluta', () => {
  const html = `
    <html><head><meta property="og:image" content="/producto.jpg"></head>
    <body><script>secreto()</script><h1>Portátil &amp; monitor</h1></body></html>`;
  assert.equal(extractVisibleText(html), 'Portátil & monitor');
  assert.equal(
    extractImageUrl(html, new URL('https://example.com/ficha/1')),
    'https://example.com/producto.jpg',
  );
});

test('valida y normaliza el producto estructurado', () => {
  const product = validateProductPayload({
    ...validProduct,
    secciones: [{ ...validProduct.secciones[0], color: 'incorrecto' }],
  });
  assert.equal(product.secciones[0].color, 's1');
  assert.equal(product.specs_rapidos.Resolución, '4K');
});

test('bloquea estructuras incompletas', () => {
  assert.throws(
    () => validateProductPayload({ nombre: 'Sin estructura' }),
    /Falta el campo marca/,
  );
});

test('usa Browser Run y devuelve el producto ya parseado', async () => {
  const originalFetch = globalThis.fetch;
  const apiRequests = [];
  const browserRequests = [];
  globalThis.fetch = async (url, options) => {
    apiRequests.push({ url: String(url), options });
    return Response.json({
      model: 'deepseek-v4-flash',
      choices: [{ message: { content: JSON.stringify(validProduct) } }],
    });
  };

  try {
    const response = await worker.fetch(
      new Request('https://worker.example', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://tienda.example/producto',
          messages: [{ role: 'user', content: 'Genera una ficha' }],
        }),
      }),
      {
        DEEPSEEK_API_KEY: 'test-key',
        BROWSER: {
          async quickAction(action, options) {
            browserRequests.push({ action, options });
            return Response.json({
              success: true,
              result: '<html><head><meta property="og:image" content="/foto.jpg"></head><body><main>Producto renderizado con JavaScript</main></body></html>',
            });
          },
        },
      },
    );

    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.product.nombre, 'Producto X');
    assert.equal(data.imageUrl, 'https://tienda.example/foto.jpg');
    assert.equal(data.renderedWithBrowser, true);
    assert.equal(browserRequests[0].action, 'content');
    assert.equal(browserRequests[0].options.gotoOptions.waitUntil, 'networkidle2');
    assert.equal(apiRequests.length, 1);

    const deepseekBody = JSON.parse(apiRequests[0].options.body);
    assert.equal(apiRequests[0].url, 'https://api.deepseek.com/chat/completions');
    assert.deepEqual(deepseekBody.response_format, { type: 'json_object' });
    assert.deepEqual(deepseekBody.thinking, { type: 'disabled' });
    assert.match(deepseekBody.messages[1].content, /Producto renderizado con JavaScript/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('usa fetch HTTP como respaldo si Browser Run falla', async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    if (String(url).startsWith('https://api.deepseek.com/')) {
      return Response.json({
        choices: [{ message: { content: JSON.stringify(validProduct) } }],
      });
    }
    return new Response('<html><body>Contenido HTTP</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  };

  try {
    const response = await worker.fetch(
      new Request('https://worker.example', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://tienda.example/producto' }),
      }),
      {
        DEEPSEEK_API_KEY: 'test-key',
        BROWSER: {
          async quickAction() {
            throw new Error('Browser no disponible');
          },
        },
      },
    );

    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.renderedWithBrowser, false);
    assert.deepEqual(requestedUrls, [
      'https://tienda.example/producto',
      'https://api.deepseek.com/chat/completions',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('usa Anthropic Haiku cuando DeepSeek falla', async () => {
  const originalFetch = globalThis.fetch;
  const apiRequests = [];
  globalThis.fetch = async (url, options) => {
    apiRequests.push({ url: String(url), options });
    if (String(url).startsWith('https://api.deepseek.com/')) {
      return Response.json({ error: { message: 'Insufficient Balance' } }, { status: 402 });
    }
    if (String(url).startsWith('https://api.anthropic.com/')) {
      return Response.json({
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: JSON.stringify(validProduct) }],
      });
    }
    throw new Error(`URL inesperada: ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request('https://worker.example', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://tienda.example/producto' }),
      }),
      {
        DEEPSEEK_API_KEY: 'deepseek-test-key',
        ANTHROPIC_KEY: 'anthropic-test-key',
        BROWSER: {
          async quickAction() {
            return Response.json({
              success: true,
              result: '<html><body>Producto renderizado</body></html>',
            });
          },
        },
      },
    );

    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.provider, 'anthropic');
    assert.equal(data.product.nombre, 'Producto X');
    assert.deepEqual(apiRequests.map((request) => request.url), [
      'https://api.deepseek.com/chat/completions',
      'https://api.anthropic.com/v1/messages',
    ]);
    const anthropicBody = JSON.parse(apiRequests[1].options.body);
    assert.equal(anthropicBody.model, 'claude-haiku-4-5-20251001');
    assert.equal(apiRequests[1].options.headers['x-api-key'], 'anthropic-test-key');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
