# High-Level Design: Kapture Finance Collections Voicebot

## 1. Architecture & Pipeline

This architecture outlines the end-to-end pipeline for the collections voicebot, integrating telephony, speech processing, LLM orchestration, and a secure backend webhook server.

**End-to-End Flow:**
- **Telephony:** Vapi handles SIP/WebRTC connections.
- **STT (Speech-to-Text):** Deepgram Nova-3 processes inbound audio in real-time.
- **LLM Orchestrator:** GPT-4o powers the conversation logic, acting as the decision engine.
- **TTS (Text-to-Speech):** ElevenLabs synthesizes the AI's responses back to audio.
- **Webhook Server:** A Node.js backend maintains the `CallSession` state and enforces authorization for all tool calls.

**Target Latency Budget:**
- **STT / endpointing:** 200–300 ms
- **LLM response:** 200–500 ms
- **Tool call (webhook round-trip):** 100–300 ms
- **TTS first audio byte:** 200–400 ms
- **Network overhead:** 50–150 ms
- **Target conversational response:** < 1.5 sec

---

## 2. CallSession & Backend State Management

To ensure security and compliance, **authentication is enforced by backend session state, not just the system prompt.** The LLM serves as a conversational interface and a secondary guardrail, but the security boundary lies within the webhook backend.

**CallSession Model:**
```javascript
{
  callId: "call_abc123",        // Vapi call identifier
  customerId: "CUST001",        // Resolved only after successful verification
  state: "AUTHENTICATED",       // Current state in the flow
  authenticated: true,          // Strict backend auth flag
  verificationAttempts: 1,      // Max 3 allowed
  language: "en",               // "en" or "hi"
  disposition: "PTP_COLLECTED"  // Final outcome code
}
```
*(In production, this in-memory Map would be replaced by Redis or a similar durable store).*

---

## 3. Conversation Flow & State Machine

The conversation is governed by a 13-state machine.

```text
GREETING
     ↓
IDENTITY_VERIFICATION
     ├── AUTH_FAILED (3 failed attempts → escalate or end)
     ├── WRONG_PERSON (no debt disclosure → end)
     └── AUTHENTICATED
              ↓
         DISCLOSURE (company, purpose, overdue amount)
              ↓
      INTENT_IDENTIFICATION
              ↓
         NEGOTIATION
          ├── PTP (promise-to-pay captured)
          ├── HARDSHIP (partial pay / extension discussed)
          ├── DISPUTE (amount contested)
          ├── ALREADY_PAID (claims payment made)
          ├── CALLBACK (requests later call)
          ├── DNC (do-not-call opt-out)
          └── ESCALATION (hostile, complex, or requested)
              ↓
           CLOSING (summarize, log disposition)
              ↓
             END
```

---

## 4. Backend Security Rules

1. **No account data before authentication.** `get_account_details` forcefully rejects unauthenticated sessions with an `AUTH_REQUIRED` error.
2. **Sensitive operations derive `customerId` from call session.** The LLM never supplies a `customerId`. It only supplies the `callId`, and the backend resolves the customer.
3. **Tool requests are associated with `callId`.** Every tool request must include this identifier for session lookup.
4. **Tool failures never result in fabricated success.** The prompt explicitly forbids inventing tool results (e.g., claiming an SMS was sent if the tool fails).
5. **Authentication expires when the call ends.** Sessions are destroyed upon receiving the `end-of-call-report`.
6. **Verification attempts are capped.** A maximum of 3 failed attempts transitions the state to `AUTH_FAILED`.

---

## 5. Tool Authorization Matrix

| Tool | UNVERIFIED | AUTHENTICATED | NEGOTIATION | CLOSING |
|------|:---:|:---:|:---:|:---:|
| `verify_customer` | ✅ | ❌ | ❌ | ❌ |
| `get_account_details` | ❌ | ✅ | ✅ | ❌ |
| `log_promise_to_pay` | ❌ | ❌ | ✅ | ❌ |
| `send_payment_link` | ❌ | ❌ | ✅ | ❌ |
| `escalate_to_agent` | ✅ | ✅ | ✅ | ✅ |
| `mark_disposition` | ✅ | ✅ | ✅ | ✅ |

---

## 6. Intents & Entities

| Intent | Entities Extracted | Next State |
|--------|-------------------|------------|
| `will_pay` | PTP date, PTP amount | PTP |
| `cannot_pay` / `hardship` | Reason, partial amount | HARDSHIP |
| `dispute_amount` | Claimed amount, reason | DISPUTE |
| `already_paid` | Payment date, ref number | ALREADY_PAID |
| `wrong_person` | — | WRONG_PERSON |
| `callback_request`| Preferred date, time | CALLBACK |
| `do_not_call` | — | DNC |
| `language_switch` | Target language (EN/HI) | (Stays in state) |

---

## 7. Tool API Definitions

1. **`verify_customer`**
   - **Input:** `callId`, `dob` (DD-MM-YYYY), `mobileLast4`
   - **Backend action:** Validates input. If matched, sets `session.authenticated = true` and resolves `customerId`.
   - **Output:** `{ "verified": true, "customerName": "Rahul Sharma" }`

2. **`get_account_details`**
   - **Input:** `callId`
   - **Backend action:** Checks auth. Uses resolved `customerId`.
   - **Output:** `{ "overdueAmount": 8499, "emiAmount": 8499, "daysPastDue": 12, "loanType": "Personal" }`

3. **`log_promise_to_pay`**
   - **Input:** `callId`, `ptpDate`, `ptpAmount`
   - **Output:** `{ "confirmationId": "PTP-9821" }`

4. **`send_payment_link`**
   - **Input:** `callId`, `channel` (sms/whatsapp)
   - **Output:** `{ "linkSent": true }`

5. **`escalate_to_agent`**
   - **Input:** `callId`, `reason`
   - **Output:** `{ "transferInitiated": true }`

6. **`mark_disposition`**
   - **Input:** `callId`, `dispositionCode`, `notes`
   - **Output:** `{ "logged": true }`

---

## 8. Guardrails & Compliance

- **Auth Verification:** DOB + last 4 digits of registered mobile number (avoids sensitive PAN data over voice).
- **Mandatory Self-Disclosure:** *"I am Maya, an AI assistant calling from Kapture Finance."*
- **Calling Hours:** Enforced to **8 AM – 7 PM IST**, adhering strictly to RBI recovery-agent guidelines.
- **Third-Party Protection:** If an unverified person answers, the bot says: *"I'm calling regarding an important personal matter for [Name]. Could you ask them to call us back?"* — absolutely no debt disclosure.
- **Brevity:** 30-word response target (exempting mandatory disclosures, auth instructions, and compliance statements).
- **Idempotency:** Webhook handles retries gracefully using `callId` + `toolCallId`.

---

## 9. Observability & Metrics

| Metric | Definition |
|--------|------------|
| **Containment Rate** | % calls resolved without human agent escalation |
| **PTP Rate** | % calls resulting in a logged promise-to-pay |
| **Auth Success Rate** | % successful verifications vs total attempts |
| **Tool Failure Rate** | % tool calls that encounter backend errors |
| **Average Latency** | Measured STT→LLM→TTS pipeline roundtrip time |
| **Drop Rate** | % calls terminated unexpectedly by the user |
