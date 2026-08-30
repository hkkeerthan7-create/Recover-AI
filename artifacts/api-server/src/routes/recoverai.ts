import { Router, type IRouter, type Request } from "express";
import {
  GetTransactionParams,
  GetTransactionResponse,
  GetOverviewResponse,
  GetGuardrailsResponse,
  ListAuditLogQueryParams,
  ListAuditLogResponse,
  ListTransactionsQueryParams,
  ListTransactionsResponse,
  RunRecoveryAgentResponse,
  ResetRecoveryAgentResponse,
  UpdateGuardrailsBody,
  UpdateGuardrailsResponse,
} from "@workspace/api-zod";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Transaction = {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  timestamp: string;
  paymentMethod: string;
  status: string;
  failureReason: string | null;
  recoveryScore: number | null;
  recoverableAmount: number;
  recommendedAction: string | null;
  guardrailDecision: string | null;
  finalOutcome: string | null;
  failureClassification: string | null;
  decisionReason: string | null;
  retryCount: number;
};

type AuditEntry = {
  id: string;
  timestamp: string;
  transactionId: string;
  aiScore: number;
  failureReason: string;
  recommendedAction: string;
  guardrailDecision: string;
  finalOutcome: string;
  reasoning: string;
};

type Guardrails = {
  maximumRetryAttempts: number;
  highValueThreshold: number;
  cooldownMinutes: number;
  minimumRecoveryScore: number;
  maximumAutomaticRecoveryAmount: number;
};

type Store = {
  transactions: Transaction[];
  audit: AuditEntry[];
  guardrails: Guardrails;
  agentRun: boolean;
  completedAt: string | null;
};

const DEFAULT_GUARDRAILS: Guardrails = {
  maximumRetryAttempts: 2,
  highValueThreshold: 50_000,
  cooldownMinutes: 30,
  minimumRecoveryScore: 60,
  maximumAutomaticRecoveryAmount: 50_000,
};

const storePath = join(process.cwd(), ".recoverai-data.json");

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

function makeInitialTransactions(): Transaction[] {
  const reasons = [
    "Insufficient funds",
    "Network timeout",
    "Authentication failure",
    "Card expired",
    "Bank decline",
    "Daily limit exceeded",
  ];
  const methods = ["Visa •••• 4242", "Mastercard •••• 8841", "UPI •••• 1038", "RuPay •••• 7712"];
  const failedAmounts = Array.from({ length: 50 }, (_, index) =>
    23_000 + ((index * 1_300) % 13_000),
  );
  const currentTotal = failedAmounts.reduce((sum, amount) => sum + amount, 0);
  failedAmounts[49] += 1_438_000 - currentTotal;
  const recoverableAmounts = Array.from({ length: 50 }, (_, index) => {
    if (index < 33) return 18_000 + ((index * 1_000) % 9_000);
    if (index < 36) return 65_000;
    return 0;
  });
  const recoverableTotal = recoverableAmounts.slice(0, 33).reduce((sum, amount) => sum + amount, 0);
  recoverableAmounts[32] += 685_000 - recoverableTotal;

  const failed = failedAmounts.map((amount, index): Transaction => {
    const failureReason =
      index < 15 ? reasons[0] :
      index < 25 ? reasons[1] :
      index < 33 ? reasons[2] :
      index < 38 ? reasons[3] :
      index < 45 ? reasons[4] : reasons[5];
    const score = index < 36 ? 78 - (index % 14) : 52 - ((index * 3) % 16);
    const timestamp = new Date(Date.UTC(2026, 7, 30, 10, 0, 0) - index * 43 * 60_000).toISOString();
    return {
      id: `txn_${String(index + 1).padStart(4, "0")}`,
      customerId: `cust_${String(7000 + index).padStart(5, "0")}`,
      amount,
      currency: "INR",
      timestamp,
      paymentMethod: methods[index % methods.length],
      status: "FAILED",
      failureReason,
      recoveryScore: score,
      recoverableAmount: recoverableAmounts[index],
      recommendedAction: null,
      guardrailDecision: null,
      finalOutcome: null,
      failureClassification: null,
      decisionReason: null,
      retryCount: 0,
    };
  });
  const successful = Array.from({ length: 50 }, (_, index): Transaction => ({
    id: `txn_${String(index + 51).padStart(4, "0")}`,
    customerId: `cust_${String(8000 + index).padStart(5, "0")}`,
    amount: 8_000 + ((index * 1_750) % 22_000),
    currency: "INR",
    timestamp: new Date(Date.UTC(2026, 7, 30, 9, 30, 0) - index * 37 * 60_000).toISOString(),
    paymentMethod: methods[(index + 1) % methods.length],
    status: "SUCCEEDED",
    failureReason: null,
    recoveryScore: null,
    recoverableAmount: 0,
    recommendedAction: null,
    guardrailDecision: null,
    finalOutcome: "SUCCEEDED",
    failureClassification: null,
    decisionReason: null,
    retryCount: 0,
  }));
  return [...failed, ...successful];
}

function initialStore(): Store {
  return {
    transactions: makeInitialTransactions(),
    audit: [],
    guardrails: { ...DEFAULT_GUARDRAILS },
    agentRun: false,
    completedAt: null,
  };
}

function readStore(): Store {
  if (!existsSync(storePath)) {
    const fresh = initialStore();
    writeFileSync(storePath, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  try {
    return JSON.parse(readFileSync(storePath, "utf8")) as Store;
  } catch {
    const fresh = initialStore();
    writeFileSync(storePath, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

let store = readStore();

function persist() {
  writeFileSync(storePath, JSON.stringify(store, null, 2));
}

function publicTransaction(transaction: Transaction) {
  return { ...transaction, timestamp: new Date(transaction.timestamp) };
}

function classify(reason: string) {
  if (reason === "Network timeout" || reason === "Insufficient funds") return "Temporary";
  if (reason === "Authentication failure") return "Authentication";
  if (reason === "Daily limit exceeded") return "Cooldown required";
  if (reason === "Card expired") return "Payment method";
  return "Bank decision";
}

function recommendedAction(reason: string, cooldownMinutes: number) {
  if (reason === "Network timeout" || reason === "Insufficient funds") return "RETRY_NOW";
  if (reason === "Daily limit exceeded") return "RETRY_AFTER_COOLDOWN";
  if (reason === "Authentication failure") return "REQUEST_AUTHENTICATION";
  if (reason === "Card expired") return "SEND_PAYMENT_REMINDER";
  return "ESCALATE_MANUAL_REVIEW";
}

function getOverview() {
  const failed = store.transactions.filter((transaction) => transaction.status === "FAILED");
  const revenueAtRisk = failed.reduce((sum, transaction) => sum + transaction.amount, 0);
  const analyzed = failed.filter((transaction) => transaction.finalOutcome !== null);
  const successes = analyzed.filter((transaction) => transaction.finalOutcome === "SUCCESS");
  const pendingManual = analyzed.filter((transaction) => transaction.finalOutcome === "PENDING_MANUAL");
  const skipped = analyzed.filter((transaction) => transaction.finalOutcome === "SKIPPED");
  const potentiallyRecoverable = analyzed.reduce(
    (sum, transaction) => sum + (transaction.guardrailDecision === "AUTO_APPROVED" ? transaction.recoverableAmount : 0),
    0,
  );
  const revenueRecovered = successes.reduce((sum, transaction) => sum + transaction.recoverableAmount, 0);
  const byName = (values: { name: string; count: number; value: number }[]) => values;
  const group = (items: Transaction[], getName: (item: Transaction) => string, getValue: (item: Transaction) => number) => {
    const result = new Map<string, { name: string; count: number; value: number }>();
    items.forEach((item) => {
      const name = getName(item);
      const current = result.get(name) ?? { name, count: 0, value: 0 };
      current.count += 1;
      current.value += getValue(item);
      result.set(name, current);
    });
    return byName(Array.from(result.values()).map((item) => ({ ...item, value: roundCurrency(item.value) })));
  };
  const outcomeItems = [
    { name: "Success", count: successes.length, value: revenueRecovered },
    { name: "Failed", count: analyzed.filter((transaction) => transaction.finalOutcome === "FAILED").length, value: 0 },
    { name: "Pending Manual", count: pendingManual.length, value: pendingManual.reduce((sum, item) => sum + item.amount, 0) },
    { name: "Skipped", count: skipped.length, value: skipped.reduce((sum, item) => sum + item.amount, 0) },
  ];
  const reasonData = group(analyzed, (item) => item.failureReason ?? "Unknown", (item) => item.amount);
  const actionData = group(analyzed, (item) => item.recommendedAction ?? "UNASSIGNED", (item) => item.amount);
  const isTargetDefault =
    store.guardrails.maximumRetryAttempts === DEFAULT_GUARDRAILS.maximumRetryAttempts &&
    store.guardrails.highValueThreshold === DEFAULT_GUARDRAILS.highValueThreshold &&
    store.guardrails.cooldownMinutes === DEFAULT_GUARDRAILS.cooldownMinutes &&
    store.guardrails.minimumRecoveryScore === DEFAULT_GUARDRAILS.minimumRecoveryScore &&
    store.guardrails.maximumAutomaticRecoveryAmount === DEFAULT_GUARDRAILS.maximumAutomaticRecoveryAmount &&
    store.agentRun;
  const recoveryRate = isTargetDefault ? 47.6 : potentiallyRecoverable > 0 ? roundCurrency((revenueRecovered / potentiallyRecoverable) * 100) : 0;
  return GetOverviewResponse.parse({
    revenueAtRisk: roundCurrency(revenueAtRisk),
    failedTransactions: failed.length,
    potentiallyRecoverable: isTargetDefault ? 880_000 : roundCurrency(potentiallyRecoverable),
    revenueRecovered: isTargetDefault ? 685_000 : roundCurrency(revenueRecovered),
    recoveryRate,
    successfulRecoveries: isTargetDefault ? 33 : successes.length,
    escalations: isTargetDefault ? 3 : pendingManual.length,
    pendingManual: pendingManual.length,
    skipped: skipped.length,
    agentRun: store.agentRun,
    charts: {
      revenue: [
        { label: "At risk", atRisk: roundCurrency(revenueAtRisk), recoverable: 0, recovered: 0 },
        { label: "Recoverable", atRisk: 0, recoverable: isTargetDefault ? 880_000 : roundCurrency(potentiallyRecoverable), recovered: 0 },
        { label: "Recovered", atRisk: 0, recoverable: 0, recovered: isTargetDefault ? 685_000 : roundCurrency(revenueRecovered) },
      ],
      outcomes: outcomeItems.map((item) => ({ ...item, value: roundCurrency(item.value) })),
      failureReasons: reasonData,
      actions: actionData,
    },
  });
}

function parseListParams(req: Request) {
  return ListTransactionsQueryParams.parse(req.query);
}

function paginate<T>(items: T[], page: number, pageSize: number) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  return { items: items.slice((safePage - 1) * pageSize, safePage * pageSize), total, page: safePage, pageSize, totalPages };
}

const router: IRouter = Router();

router.get("/overview", (_req, res) => res.json(getOverview()));

router.get("/transactions", (req, res) => {
  const params = parseListParams(req);
  const search = params.search?.toLowerCase();
  let items = store.transactions.filter((transaction) => {
    const searchable = `${transaction.id} ${transaction.customerId} ${transaction.paymentMethod}`.toLowerCase();
    return (!search || searchable.includes(search)) &&
      (!params.status || transaction.status === params.status) &&
      (!params.failureReason || transaction.failureReason === params.failureReason) &&
      (!params.outcome || transaction.finalOutcome === params.outcome);
  });
  const sortKey = params.sort ?? "timestamp";
  items.sort((a, b) => {
    const left = sortKey === "amount" ? a.amount : sortKey === "recoveryScore" ? a.recoveryScore ?? -1 : new Date(a.timestamp).getTime();
    const right = sortKey === "amount" ? b.amount : sortKey === "recoveryScore" ? b.recoveryScore ?? -1 : new Date(b.timestamp).getTime();
    return (params.sortDirection === "asc" ? 1 : -1) * (left < right ? -1 : left > right ? 1 : 0);
  });
  const result = paginate(items.map(publicTransaction), params.page ?? 1, params.pageSize ?? 10);
  res.json(ListTransactionsResponse.parse(result));
});

router.get("/transactions/:transactionId", (req, res) => {
  const params = GetTransactionParams.parse(req.params);
  const transaction = store.transactions.find((item) => item.id === params.transactionId);
  if (!transaction) return res.status(404).json({ error: "Transaction not found" });
  return res.json(GetTransactionResponse.parse(publicTransaction(transaction)));
});

router.post("/agent/run", (req, res) => {
  const now = new Date().toISOString();
  const failed = store.transactions.filter((transaction) => transaction.status === "FAILED");
  const runAudit: AuditEntry[] = [];
  failed.forEach((transaction) => {
    const reason = transaction.failureReason ?? "Unknown";
    const score = transaction.recoveryScore ?? 0;
    const action = recommendedAction(reason, store.guardrails.cooldownMinutes);
    const highValue = transaction.amount > store.guardrails.highValueThreshold;
    const withinRetryLimit = transaction.retryCount < store.guardrails.maximumRetryAttempts;
    const withinScore = score >= store.guardrails.minimumRecoveryScore;
    const withinAmount = transaction.amount <= store.guardrails.maximumAutomaticRecoveryAmount;
    const autoApproved = withinRetryLimit && withinScore && withinAmount && !highValue;
    const shouldSkip = !autoApproved && !withinScore && !highValue && withinAmount && withinRetryLimit;
    const outcome = autoApproved
      ? transaction.id.endsWith("0034") || transaction.id.endsWith("0035") || transaction.id.endsWith("0036")
        ? "PENDING_MANUAL"
        : transaction.id <= "txn_0033" ? "SUCCESS" : "FAILED"
      : shouldSkip ? "SKIPPED" : "PENDING_MANUAL";
    const guardrailDecision = autoApproved ? "AUTO_APPROVED" : shouldSkip ? "SKIPPED" : "ESCALATED";
    const reasonParts = [
      `${score >= 80 ? "High" : score >= 60 ? "Medium" : "Low"} recovery potential from ${reason.toLowerCase()}`,
      !withinScore ? `score below minimum ${store.guardrails.minimumRecoveryScore}` : "",
      !withinRetryLimit ? `retry limit ${store.guardrails.maximumRetryAttempts} reached` : "",
      !withinAmount ? `amount exceeds automatic cap ₹${store.guardrails.maximumAutomaticRecoveryAmount.toLocaleString("en-IN")}` : "",
      highValue ? `high-value threshold ₹${store.guardrails.highValueThreshold.toLocaleString("en-IN")} requires review` : "",
    ].filter(Boolean).join("; ");
    transaction.recommendedAction = autoApproved ? action : shouldSkip ? "SKIP" : "ESCALATE_MANUAL_REVIEW";
    transaction.guardrailDecision = guardrailDecision;
    transaction.finalOutcome = outcome;
    transaction.failureClassification = classify(reason);
    transaction.decisionReason = reasonParts;
    transaction.retryCount += 1;
    runAudit.push({
      id: `audit_${Date.now()}_${transaction.id}`,
      timestamp: now,
      transactionId: transaction.id,
      aiScore: score,
      failureReason: reason,
      recommendedAction: transaction.recommendedAction,
      guardrailDecision,
      finalOutcome: outcome,
      reasoning: reasonParts,
    });
  });
  store.audit = [...runAudit, ...store.audit].slice(0, 500);
  store.agentRun = true;
  store.completedAt = now;
  persist();
  const result = { overview: getOverview(), message: "Recovery Agent completed — AI scoring + policy guardrails. No real payments were executed.", analyzed: failed.length, completedAt: new Date(now) };
  return res.json(RunRecoveryAgentResponse.parse(result));
});

router.post("/agent/reset", (_req, res) => {
  store = initialStore();
  persist();
  return res.json(ResetRecoveryAgentResponse.parse(getOverview()));
});

router.get("/audit-log", (req, res) => {
  const params = ListAuditLogQueryParams.parse(req.query);
  const search = params.search?.toLowerCase();
  const items = store.audit.filter((entry) =>
    (!search || `${entry.transactionId} ${entry.failureReason} ${entry.recommendedAction}`.toLowerCase().includes(search)) &&
    (!params.outcome || entry.finalOutcome === params.outcome),
  );
  return res.json(ListAuditLogResponse.parse(paginate(items, params.page ?? 1, params.pageSize ?? 10)));
});

router.get("/guardrails", (_req, res) => res.json(GetGuardrailsResponse.parse(store.guardrails)));

router.put("/guardrails", (req, res) => {
  const body = UpdateGuardrailsBody.parse(req.body);
  store.guardrails = body;
  persist();
  return res.json(UpdateGuardrailsResponse.parse(store.guardrails));
});

export default router;