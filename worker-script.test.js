import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyPageCondition,
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
  specs_rapidos: { Resolución: '4K', Puertos: 'HDMI', Brillo: '400 nits' },
  secciones: [
    {
      titulo: 'Pantalla',
      color: 's1',
      filas: [
        { campo: 'Resolución', valor: '3840 x 2160' },
        { campo: 'Puertos', valor: 'HDMI' },
        { campo: 'Brillo', valor: '400 nits' },
      ],
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
  assert.equal(
    extractImageUrl('', new URL('https://www.falabella.com/falabella-cl/product/145739361/Notebook-Pant-marcada/145739362')),
    'https://media.falabella.com/falabellaCL/145739362_01/public',
  );
  assert.equal(
    extractImageUrl(
      '<script type="application/ld+json">{"@type":"Product","image":["https://cdn.example/foto.webp"]}</script>',
      new URL('https://tienda.example/p/1'),
    ),
    'https://cdn.example/foto.webp',
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

test('corrige Nuevo si el HTML dice reacondicionado', () => {
  const html = '<table><tr><td>Condicion del producto</td><td>Reacondicionado excelente (A)</td></tr></table>';
  const product = applyPageCondition(validProduct, 'Condicion del producto Reacondicionado excelente (A)', html);
  assert.equal(product.condicion, 'Reacondicionado excelente (A)');
});

test('no cambia Nuevo por menciones secundarias o por la URL', () => {
  const relatedHtml = '<main>Producto nuevo</main><aside>También disponible reacondicionado</aside>';
  assert.equal(
    applyPageCondition(validProduct, 'Producto nuevo. Otros reacondicionados', relatedHtml, 'https://tienda.example/nuevo').condicion,
    'Nuevo',
  );
  assert.equal(
    applyPageCondition(validProduct, 'Producto nuevo', '<main>Producto nuevo</main>', 'https://tienda.example/nuevo?refurbished=false').condicion,
    'Nuevo',
  );
  assert.equal(
    applyPageCondition(validProduct, 'Producto nuevo', '<script>const category = "refurbished";</script>', 'https://tienda.example/nuevo').condicion,
    'Nuevo',
  );
});

test('usa la condición JSON-LD del producto principal', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Product',
    url: 'https://tienda.example/producto/1',
    name: 'Producto X',
    offers: { itemCondition: 'https://schema.org/RefurbishedCondition' },
  })}</script>`;
  const product = applyPageCondition(
    validProduct,
    'Producto X',
    html,
    'https://tienda.example/producto/1?utm_source=chatgpt.com',
  );
  assert.equal(product.condicion, 'Reacondicionado');
});

test('ignora JSON-LD ambiguo de productos relacionados', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@graph': [
      { '@type': 'Product', name: 'Principal', itemCondition: 'https://schema.org/NewCondition' },
      { '@type': 'Product', name: 'Relacionado', itemCondition: 'https://schema.org/RefurbishedCondition' },
    ],
  })}</script>`;
  assert.equal(applyPageCondition(validProduct, 'Producto nuevo', html).condicion, 'Nuevo');
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
      const anthropicProduct = {
        ...validProduct,
        specs_rapidos: [
          { campo: 'Resolución', valor: '4K' },
          { campo: 'Puertos', valor: 'HDMI' },
          { campo: 'Brillo', valor: '400 nits' },
        ],
      };
      return Response.json({
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: `Aquí tienes:\n\`\`\`json\n${JSON.stringify(anthropicProduct)}\n\`\`\`` }],
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
    assert.equal(anthropicBody.output_config.format.type, 'json_schema');
    assert.equal(anthropicBody.output_config.format.schema.additionalProperties, false);
    assert.deepEqual(
      anthropicBody.output_config.format.schema.required,
      ['nombre', 'marca', 'condicion', 'descripcion', 'tipo', 'specs_rapidos', 'secciones'],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('un proveedor colgado agota tiempo y continúa con Anthropic', async () => {
  const originalFetch = globalThis.fetch;
  let deepSeekCalls = 0;
  globalThis.fetch = async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    if (String(url).startsWith('https://api.deepseek.com/')) {
      deepSeekCalls += 1;
      throw new DOMException('Tiempo agotado', 'TimeoutError');
    }
    return Response.json({
      content: [{ type: 'text', text: JSON.stringify(validProduct) }],
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
        DEEPSEEK_API_KEY: 'deepseek-test-key',
        ANTHROPIC_KEY: 'anthropic-test-key',
        BROWSER: {
          async quickAction() {
            return Response.json({ success: true, result: '<html><body>Producto renderizado</body></html>' });
          },
        },
      },
    );

    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.provider, 'anthropic');
    assert.equal(deepSeekCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('si la tienda responde 403 no fuerza la condición desde la URL', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://api.deepseek.com/')) {
      return Response.json({
        choices: [{ message: { content: JSON.stringify(validProduct) } }],
      });
    }
    return new Response('Forbidden', { status: 403 });
  };

  try {
    const response = await worker.fetch(
      new Request('https://worker.example', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://www.falabella.com/falabella-cl/product/1/Notebook-Pant-marcada/1',
        }),
      }),
      {
        DEEPSEEK_API_KEY: 'test-key',
        BROWSER: {
          async quickAction() {
            return new Response('rate limited', { status: 429 });
          },
        },
      },
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.product.nombre, 'Producto X');
    assert.equal(data.product.condicion, 'Nuevo');
    assert.equal(data.imageUrl, 'https://media.falabella.com/falabellaCL/1_01/public');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('una ficha válida pero insuficiente activa el fallback con HTML bruto', async () => {
  const originalFetch = globalThis.fetch;
  const sparseProduct = {
    ...validProduct,
    specs_rapidos: { Resolución: '4K' },
    secciones: [{ ...validProduct.secciones[0], filas: validProduct.secciones[0].filas.slice(0, 1) }],
  };
  let apiCalls = 0;
  globalThis.fetch = async () => {
    apiCalls += 1;
    return Response.json({
      choices: [{ message: { content: JSON.stringify(apiCalls === 1 ? sparseProduct : validProduct) } }],
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
            return Response.json({ success: true, result: '<html><body>Ficha técnica completa</body></html>' });
          },
        },
      },
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.extractionMode, 'raw_html');
    assert.equal(data.rawHtmlChunks, 1);
    assert.equal(apiCalls, 2);
    assert.equal(Object.keys(data.product.specs_rapidos).length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('JSON roto activa HTML bruto y una reparación estructurada', async () => {
  const originalFetch = globalThis.fetch;
  let apiCalls = 0;
  globalThis.fetch = async () => {
    apiCalls += 1;
    const content = apiCalls < 3 ? 'salida rota sin JSON' : JSON.stringify(validProduct);
    return Response.json({ choices: [{ message: { content } }] });
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
            return Response.json({ success: true, result: '<html><body>Producto completo</body></html>' });
          },
        },
      },
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.extractionMode, 'raw_html');
    assert.equal(apiCalls, 3);
    assert.equal(data.product.nombre, 'Producto X');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('HTML grande se procesa completo por fragmentos y se consolida', async () => {
  const originalFetch = globalThis.fetch;
  let structuredCalls = 0;
  let evidenceCalls = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.response_format) {
      structuredCalls += 1;
      return Response.json({
        choices: [{ message: { content: structuredCalls === 1 ? 'JSON inválido' : JSON.stringify(validProduct) } }],
      });
    }
    evidenceCalls += 1;
    return Response.json({ choices: [{ message: { content: `Evidencia ${evidenceCalls}` } }] });
  };

  try {
    const largeHtml = `<html><body>${'detalle '.repeat(18000)}</body></html>`;
    const response = await worker.fetch(
      new Request('https://worker.example', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://tienda.example/producto-grande' }),
      }),
      {
        DEEPSEEK_API_KEY: 'test-key',
        BROWSER: {
          async quickAction() {
            return Response.json({ success: true, result: largeHtml });
          },
        },
      },
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.extractionMode, 'raw_html_chunks');
    assert.ok(data.rawHtmlChunks > 1);
    assert.equal(evidenceCalls, data.rawHtmlChunks);
    assert.equal(structuredCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reintenta una vez un 429 y conserva el camino rápido', async () => {
  const originalFetch = globalThis.fetch;
  let apiCalls = 0;
  globalThis.fetch = async () => {
    apiCalls += 1;
    if (apiCalls === 1) return Response.json({ error: { message: 'Rate limited' } }, { status: 429 });
    return Response.json({ choices: [{ message: { content: JSON.stringify(validProduct) } }] });
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
            return Response.json({ success: true, result: '<html><body>Producto</body></html>' });
          },
        },
      },
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.extractionMode, 'clean_text');
    assert.equal(apiCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('conserva una ficha válida si todos los intentos de mejora fallan', async () => {
  const originalFetch = globalThis.fetch;
  const sparseProduct = {
    ...validProduct,
    specs_rapidos: { Resolución: '4K' },
    secciones: [{ ...validProduct.secciones[0], filas: validProduct.secciones[0].filas.slice(0, 1) }],
  };
  let apiCalls = 0;
  globalThis.fetch = async () => {
    apiCalls += 1;
    const content = apiCalls === 1 ? JSON.stringify(sparseProduct) : 'JSON inválido';
    return Response.json({ choices: [{ message: { content } }] });
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
            return Response.json({ success: true, result: '<html><body>Producto</body></html>' });
          },
        },
      },
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.extractionMode, 'clean_text');
    assert.equal(Object.keys(data.product.specs_rapidos).length, 1);
    assert.ok(data.warnings.length >= 2);
    assert.equal(apiCalls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
