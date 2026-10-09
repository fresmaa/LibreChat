const express = require('express');
const { execFileSync } = require('child_process');
const { logger } = require('@librechat/data-schemas');

const router = express.Router();

function transformToSiderFormat(messages) {
  return (messages || []).map(msg => {
    let content;
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map(p => p.text || '').join('');
    } else {
      content = '';
    }
    return {
      type: 'text',
      text: content,
      user_input_text: msg.role === 'user' ? content : undefined
    };
  });
}

function handleSiderRequest(req, res) {
  try {
    const { messages, model } = req.body;

    const siderBody = {
      model: model || 'claude-opus-5.5',
      from: 'chat',
      client_prompt: {},
      multi_content: transformToSiderFormat(messages),
      prompt_templates: [],
      tools: { auto: [] },
      think_mode: { enable: false }
    };

    const bodyJson = JSON.stringify(siderBody);
    const apiKey = process.env.SIDER_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: { message: 'SIDER_API_KEY not configured', type: 'configuration_error' } });
    }

    const response = execFileSync('curl', [
      '-s', '-X', 'POST',
      'https://sider.ai/api/chat/v1/completions',
      '-H', 'Content-Type: application/json',
      '-H', `Authorization: Bearer ${apiKey}`,
      '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      '-H', 'Accept: */*',
      '-H', 'Origin: https://sider.ai',
      '-H', 'Referer: https://sider.ai/chat',
      '-H', 'Accept-Language: en-US,en;q=0.9',
      '-H', 'X-App-Name: ChitChat_Web',
      '-H', 'X-App-Version: 1.0.0',
      '-H', 'X-Time-Zone: Asia/Jakarta',
      '-d', bodyJson
    ], {
      encoding: 'utf-8',
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024
    });

    const normalizedResponse = response.replace(/\r\n/g, '\n');
    const events = normalizedResponse.split('\n\n');
    let fullContent = '';

    for (const event of events) {
      const trimmedEvent = event.trim();
      if (trimmedEvent.startsWith('data:')) {
        try {
          const json = JSON.parse(trimmedEvent.slice(5).trim());
          const data = json.data || json;
          const eventType = data.type || '';

          if (eventType === 'text' && data.text) {
            fullContent += data.text;
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }

    logger.info(`[Sider Proxy] Content length: ${fullContent.length}`);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const chunkId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    const initialChunk = {
      id: chunkId,
      object: 'chat.completion.chunk',
      created: created,
      model: siderBody.model,
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: '' },
        finish_reason: null
      }]
    };
    res.write(`data: ${JSON.stringify(initialChunk)}\n\n`);

    if (fullContent) {
      const contentChunk = {
        id: chunkId,
        object: 'chat.completion.chunk',
        created: created,
        model: siderBody.model,
        choices: [{
          index: 0,
          delta: { content: fullContent },
          finish_reason: null
        }]
      };
      res.write(`data: ${JSON.stringify(contentChunk)}\n\n`);
    }

    const finalChunk = {
      id: chunkId,
      object: 'chat.completion.chunk',
      created: created,
      model: siderBody.model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop'
      }]
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    logger.error(`[Sider Proxy] Error: ${error.message}`);
    if (error.stderr) {
      logger.error(`[Sider Proxy] Stderr: ${error.stderr.toString().substring(0, 500)}`);
    }
    
    // Send error as SSE
    res.writeHead(502, {
      'Content-Type': 'text/event-stream'
    });
    res.write(`data: ${JSON.stringify({ error: { message: error.message, type: 'sider_api_error' } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

router.post('/', handleSiderRequest);
router.post('/v1/chat/completions', handleSiderRequest);

router.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'claude-opus-5.5', object: 'model', owned_by: 'sider' },
      { id: 'gpt-4o', object: 'model', owned_by: 'sider' },
      { id: 'gemini-2.5-pro', object: 'model', owned_by: 'sider' }
    ]
  });
});

module.exports = router;
