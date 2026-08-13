# Kapture Finance Collections Voicebot

This repository contains the complete implementation for the Kapture Finance Collections Voicebot ("Maya"), including the High-Level Design (HLD), Vapi configurations, and a secure backend webhook server.

## Overview

Maya is an outbound voice AI agent designed to collect overdue EMIs politely and compliantly. This implementation emphasizes **backend-enforced security** over prompt-based guardrails. The LLM acts as the conversational interface, but state transitions and sensitive data access are controlled by a Node.js webhook server.

## Design Choices

1. **Backend-Enforced Authentication:** The AI cannot simply be prompted to bypass auth. The `get_account_details` tool will reject any request lacking an authenticated backend session for that specific call.
2. **Identity Verification:** Uses Date of Birth + the last 4 digits of the registered mobile number. This avoids collecting highly sensitive PAN data over voice channels while remaining secure.
3. **Speech-to-Text (STT): Deepgram Nova-3.** Selected for its superior accuracy with Indian English accents and seamless Hindi code-switching.
4. **LLM Orchestration: GPT-4o.** Selected for its robust instruction following, reliable JSON schema generation for tool calls, and sufficient latency for voice prototypes.
5. **Text-to-Speech (TTS): ElevenLabs.** Selected for providing a clear, empathetic, and professional voice appropriate for sensitive collections conversations.
6. **Calling Hours Compliance:** Prompts and system designs assume dialing restricted to 8 AM – 7 PM IST, complying with RBI fair practices for recovery agents.

## Project Structure

```
├── docs/
│   ├── HLD.md                   # High-Level Design document
│   ├── architecture-diagram.md  # Mermaid architecture diagram
│   └── test-cases.md            # Extensive test cases for edge scenarios
├── server/
│   ├── index.js                 # Express webhook server with CallSession state
│   └── package.json             
├── vapi-config/
│   ├── assistant-config.json    # Vapi assistant configuration
│   ├── system-prompt.md         # The conversational prompt
│   └── tools.json               # Schemas for the 6 custom tools
└── README.md
```

## Setup Instructions

### 1. Run the Webhook Server Locally

The server provides the APIs that Vapi will call during the conversation.

```bash
cd server
npm install
npm start
```

By default, it runs on port 3000.

### 2. Expose the Server (ngrok)

Vapi needs a public URL to reach your local server.

```bash
ssh -p 443 -R0:localhost:3000 a.pinggy.io
```
*Note the HTTPS forwarding URL (e.g., `https://rnxyz.run.pinggy-free.link`).*

### 3. Configure Vapi.ai

1. Create a free account at [Vapi.ai](https://vapi.ai).
2. Go to the **Assistants** tab and create a new assistant.
3. Copy the contents of `vapi-config/system-prompt.md` into the System Prompt section.
4. Replace `YOUR_WEBHOOK_URL` in `vapi-config/tools.json` with your Pinggy URL.
5. Add the tools from `tools.json` using Vapi's Function Tool creator.
6. In **Settings**, set the Server URL to your Pinggy URL (e.g., `https://rnxyz.run.pinggy-free.link/api/vapi-webhook`) to receive call lifecycle events (like `end-of-call-report` for session cleanup).
7. Configure STT to Deepgram Nova-3, Model to GPT-4o, and Voice to your preferred ElevenLabs voice.

### 4. Test the Bot

Click "Talk to Assistant" in the Vapi dashboard.
- Provide the mock details to verify: **DOB: 15-08-1998**, **Mobile Last 4: 1234**.
- Try edge cases like refusing to verify, or claiming to be the wrong person.

## Debugging Notes & Failure Handling

- **Idempotency:** Vapi sometimes retries tool calls if the network blips. The server deduplicates requests using `toolCallId` to prevent logging the same promise-to-pay twice.
- **Tool Failures:** If a tool like `send_payment_link` fails, the prompt instructs the AI to *not* invent a success story, but rather inform the customer honestly.
- **Latency Check:** The target pipeline response time is < 1.5 seconds. If higher, ensure the ngrok connection isn't bottlenecking the webhooks.

## Improvements with More Time

If I had more time to bring this to production, I would:
1. **Durable Sessions:** Replace the in-memory `Map` with Redis to support scaled, multi-instance webhook servers.
2. **Real Integrations:** Wire the mock endpoints to a real CRM (like Salesforce) and payment gateway (like Razorpay/Twilio SMS).
3. **Advanced Anomaly Detection:** Add a background worker that terminates calls if the AI strays from the topic (off-topic hallucination detection).
4. **PCI Compliance Layer:** Ensure that if we ever capture card details, it happens via DTMF (keypad input) masked from the LLM entirely.
