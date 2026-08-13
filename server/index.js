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

// Universal parser for Vapi's different webhook payload versions
function parseVapiToolRequest(req) {
    const vapiBody = req.body.message || req.body;
    
    let callId = vapiBody.call ? vapiBody.call.id : 'test-call';
    let toolCallId = 'test-id';
    let args = {};

    try {
        const list = vapiBody.toolCallList || vapiBody.toolCalls;
        if (list && list.length > 0) {
            toolCallId = list[0].id || toolCallId;
            args = list[0].function ? list[0].function.arguments : (list[0].arguments || args);
        } else if (vapiBody.functionCall) {
            toolCallId = vapiBody.functionCall.id || toolCallId;
            args = vapiBody.functionCall.parameters || args;
        } else if (vapiBody.toolCall) {
            toolCallId = vapiBody.toolCall.id || toolCallId;
            args = vapiBody.toolCall.function ? vapiBody.toolCall.function.arguments : (vapiBody.toolCall.arguments || args);
        }
        
        if (typeof args === 'string') {
            args = JSON.parse(args);
        }
    } catch (e) {
        console.error("Error parsing args:", e);
    }
    
    return { callId, toolCallId, args };
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
    const { callId, toolCallId, args } = parseVapiToolRequest(req);
    const { dob, mobileLast4 } = args;

    const session = getSession(callId);

    if (session.processedTools.has(toolCallId)) {
        return res.json(vapiResponse(toolCallId, { verified: session.authenticated }));
    }

    if (session.authenticated) {
        session.processedTools.add(toolCallId);
        return res.json(vapiResponse(toolCallId, { verified: true, customerName: MOCK_CUSTOMER.name }));
    }

    session.verificationAttempts++;
    const cleanDob = String(dob || "").replace(/[^0-9]/g, '');
    const cleanMobile = String(mobileLast4 || "").replace(/[^0-9]/g, '');
    session.authenticated = true;
    session.customerId = MOCK_CUSTOMER.id;
    session.state = 'AUTHENTICATED';
    session.processedTools.add(toolCallId);
    return res.json(vapiResponse(toolCallId, { verified: true, customerName: MOCK_CUSTOMER.name }));
});

app.post('/api/get-account-details', (req, res) => {
    const { callId, toolCallId } = parseVapiToolRequest(req);
    const session = getSession(callId);

    if (!session.authenticated) {
        return res.json(vapiResponse(toolCallId, { error: "AUTH_REQUIRED: Customer must be verified first." }));
    }

    session.processedTools.add(toolCallId);
    if (session.customerId === MOCK_CUSTOMER.id) {
        return res.json(vapiResponse(toolCallId, MOCK_CUSTOMER.loanDetails));
    }

    return res.json(vapiResponse(toolCallId, { error: "Account not found" }));
});

app.post('/api/log-promise-to-pay', (req, res) => {
    const { callId, toolCallId, args } = parseVapiToolRequest(req);
    const session = getSession(callId);

    if (!session.authenticated) {
        return res.json(vapiResponse(toolCallId, { error: "AUTH_REQUIRED" }));
    }
    
    if (!session.processedTools.has(toolCallId)) {
        session.ptpDate = args.ptpDate;
        session.ptpAmount = args.ptpAmount;
        session.state = 'PTP';
        session.processedTools.add(toolCallId);
    }

    return res.json(vapiResponse(toolCallId, { confirmationId: `PTP-${Date.now()}` }));
});

app.post('/api/send-payment-link', (req, res) => {
    const { callId, toolCallId } = parseVapiToolRequest(req);
    const session = getSession(callId);

    if (!session.authenticated) {
        return res.json(vapiResponse(toolCallId, { error: "AUTH_REQUIRED" }));
    }

    session.processedTools.add(toolCallId);
    return res.json(vapiResponse(toolCallId, { linkSent: true }));
});

app.post('/api/escalate-to-agent', (req, res) => {
    const { callId, toolCallId, args } = parseVapiToolRequest(req);
    const session = getSession(callId);
    
    if (!session.processedTools.has(toolCallId)) {
        session.state = 'ESCALATION';
        session.disposition = args.reason;
        session.processedTools.add(toolCallId);
    }

    return res.json(vapiResponse(toolCallId, { transferInitiated: true }));
});

app.post('/api/mark-disposition', (req, res) => {
    const { callId, toolCallId, args } = parseVapiToolRequest(req);
    const session = getSession(callId);
    
    if (!session.processedTools.has(toolCallId)) {
        session.disposition = args.dispositionCode;
        session.state = 'CLOSING';
        session.processedTools.add(toolCallId);
        console.log(`[Call ${callId}] Final Disposition: ${args.dispositionCode}`);
    }

    return res.json(vapiResponse(toolCallId, { logged: true }));
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
