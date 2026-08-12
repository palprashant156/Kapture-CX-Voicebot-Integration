const express = require('express');
const app = express();
app.use(express.json());

// Log all incoming requests so you can see activity in the terminal
app.use((req, res, next) => {
    console.log(`[${new Date().toLocaleTimeString()}] Incoming ${req.method} request to ${req.url}`);
    next();
});

const PORT = process.env.PORT || 3000;

const sessions = new Map();

function getSession(callId) {
    if (!sessions.has(callId)) {
        sessions.set(callId, {
            callId,
            customerId: null,
            state: 'UNVERIFIED',
            authenticated: false,
            verificationAttempts: 0,
            language: 'en',
            disposition: null,
            ptpDate: null,
            ptpAmount: null,
            createdAt: Date.now(),
            processedTools: new Set()
        });
    }
    return sessions.get(callId);
}

function vapiResponse(toolCallId, resultObj) {
    return {
        results: [
            {
                toolCallId,
                result: JSON.stringify(resultObj)
            }
        ]
    };
}

const MOCK_CUSTOMER = {
    id: "CUST_9981",
    name: "Rahul Sharma",
    dob: "15-08-1998",
    mobileLast4: "1234",
    loanDetails: {
        overdueAmount: 8499,
        emiAmount: 8499,
        daysPastDue: 12,
        loanType: "Personal"
    }
};

app.post('/api/verify-customer', (req, res) => {
    const vapiBody = req.body.message;
    if (!vapiBody || vapiBody.type !== 'tool-calls') return res.status(400).send('Invalid request');

    const toolCall = vapiBody.toolCalls[0];
    const callId = vapiBody.call.id;
    const { dob, mobileLast4 } = toolCall.function.arguments;

    const session = getSession(callId);

    if (session.processedTools.has(toolCall.id)) {
        return res.json(vapiResponse(toolCall.id, { verified: session.authenticated }));
    }

    if (session.authenticated) {
        session.processedTools.add(toolCall.id);
        return res.json(vapiResponse(toolCall.id, { verified: true, customerName: MOCK_CUSTOMER.name }));
    }

    session.verificationAttempts++;

    if (dob === MOCK_CUSTOMER.dob && mobileLast4 === MOCK_CUSTOMER.mobileLast4) {
        session.authenticated = true;
        session.customerId = MOCK_CUSTOMER.id;
        session.state = 'AUTHENTICATED';
        session.processedTools.add(toolCall.id);
        return res.json(vapiResponse(toolCall.id, { verified: true, customerName: MOCK_CUSTOMER.name }));
    }

    if (session.verificationAttempts >= 3) {
        session.state = 'AUTH_FAILED';
        session.processedTools.add(toolCall.id);
        return res.json(vapiResponse(toolCall.id, { verified: false, error: "Max attempts reached" }));
    }

    session.processedTools.add(toolCall.id);
    return res.json(vapiResponse(toolCall.id, { verified: false, error: "Incorrect details" }));
});

app.post('/api/get-account-details', (req, res) => {
    const vapiBody = req.body.message;
    if (!vapiBody || vapiBody.type !== 'tool-calls') return res.status(400).send('Invalid request');

    const toolCall = vapiBody.toolCalls[0];
    const callId = vapiBody.call.id;
    const session = getSession(callId);

    if (!session.authenticated) {
        return res.json(vapiResponse(toolCall.id, { error: "AUTH_REQUIRED: Customer must be verified first." }));
    }

    session.processedTools.add(toolCall.id);
    if (session.customerId === MOCK_CUSTOMER.id) {
        return res.json(vapiResponse(toolCall.id, MOCK_CUSTOMER.loanDetails));
    }

    return res.json(vapiResponse(toolCall.id, { error: "Account not found" }));
});

app.post('/api/log-promise-to-pay', (req, res) => {
    const vapiBody = req.body.message;
    const toolCall = vapiBody.toolCalls[0];
    const callId = vapiBody.call.id;
    const session = getSession(callId);

    if (!session.authenticated) {
        return res.json(vapiResponse(toolCall.id, { error: "AUTH_REQUIRED" }));
    }

    const { ptpDate, ptpAmount } = toolCall.function.arguments;
    
    if (!session.processedTools.has(toolCall.id)) {
        session.ptpDate = ptpDate;
        session.ptpAmount = ptpAmount;
        session.state = 'PTP';
        session.processedTools.add(toolCall.id);
    }

    return res.json(vapiResponse(toolCall.id, { confirmationId: `PTP-${Date.now()}` }));
});

app.post('/api/send-payment-link', (req, res) => {
    const vapiBody = req.body.message;
    const toolCall = vapiBody.toolCalls[0];
    const callId = vapiBody.call.id;
    const session = getSession(callId);

    if (!session.authenticated) {
        return res.json(vapiResponse(toolCall.id, { error: "AUTH_REQUIRED" }));
    }

    session.processedTools.add(toolCall.id);
    return res.json(vapiResponse(toolCall.id, { linkSent: true }));
});

app.post('/api/escalate-to-agent', (req, res) => {
    const vapiBody = req.body.message;
    const toolCall = vapiBody.toolCalls[0];
    const callId = vapiBody.call.id;
    const session = getSession(callId);
    
    const { reason } = toolCall.function.arguments;

    if (!session.processedTools.has(toolCall.id)) {
        session.state = 'ESCALATION';
        session.disposition = reason;
        session.processedTools.add(toolCall.id);
    }

    return res.json(vapiResponse(toolCall.id, { transferInitiated: true }));
});

app.post('/api/mark-disposition', (req, res) => {
    const vapiBody = req.body.message;
    const toolCall = vapiBody.toolCalls[0];
    const callId = vapiBody.call.id;
    const session = getSession(callId);
    
    const { dispositionCode, notes } = toolCall.function.arguments;

    if (!session.processedTools.has(toolCall.id)) {
        session.disposition = dispositionCode;
        session.state = 'CLOSING';
        session.processedTools.add(toolCall.id);
        console.log(`[Call ${callId}] Final Disposition: ${dispositionCode} ${notes ? `(${notes})` : ''}`);
    }

    return res.json(vapiResponse(toolCall.id, { logged: true }));
});

app.post('/api/vapi-webhook', (req, res) => {
    const vapiBody = req.body.message;
    if (vapiBody && vapiBody.type === 'end-of-call-report') {
        const callId = vapiBody.call.id;
        console.log(`[Call ${callId}] Call ended. Cleaning up session.`);
        sessions.delete(callId);
    }
    res.status(200).send('OK');
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
