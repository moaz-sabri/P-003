// The app's error types.
//
// Every one of them carries a `code`, and every code has an `error.<code>`
// string in both language tables. That contract is what lets every catch site in
// the UI do the same one thing — `toast.show(`error.${e.code}`)` — instead of
// each one inventing a fallback. An error without a code falls back to
// `e.message`, which for a transition error is the *action name*: trying to
// finish an exercise that was never started produced a toast reading
// "error.finish".

export class ValidationError extends Error {
    /** @param {string} field @param {string} code */
    constructor(field, code) {
        super(code);
        this.name = "ValidationError";
        this.field = field;
        this.code = code;
    }
}

export class InvalidTransitionError extends Error {
    /** @param {string} from @param {string} action */
    constructor(from, action) {
        // The message keeps the detail for the console; the code is the one the
        // user sees, so it says what happened rather than what was attempted.
        super(`${action} is not allowed from ${from}`);
        this.name = "InvalidTransitionError";
        this.from = from;
        this.action = action;
        this.code = "invalid_transition";
    }
}

export class NotFoundError extends Error {
    /** @param {string} entity @param {string} id */
    constructor(entity, id) {
        super("not_found");
        this.name = "NotFoundError";
        this.entity = entity;
        this.id = id;
        this.code = "not_found";
    }
}

/** The plan says this is not the moment. Its code is the reason, so the UI can
 *  say "come back tomorrow" without knowing the rule. */
export class ScheduleError extends Error {
    /** @param {string} code */
    constructor(code) {
        super(code);
        this.name = "ScheduleError";
        this.code = code;
    }
}

export class CryptoError extends Error {
    /** @param {string} code */
    constructor(code) {
        super(code);
        this.name = "CryptoError";
        this.code = code;
    }
}

export class SyncError extends Error {
    /** @param {string} code */
    constructor(code) {
        super(code);
        this.name = "SyncError";
        this.code = code;
    }
}

/** An imported key that is not a key. The detail is kept for the console; the
 *  code is what the reader is shown. */
export class ImportError extends Error {
    /**
     * @param {string} code
     * @param {unknown} [detail]
     */
    constructor(code, detail = null) {
        super(code);
        this.name = "ImportError";
        this.code = code;
        this.detail = detail;
    }
}

// A write that awaited something outside its own transaction, so the
// transaction committed before the write finished. It is a bug in the caller,
// not bad input, and it is deliberately loud: the alternative is reporting
// success for records that were never written.
export class TransactionInactiveError extends Error {
    constructor() {
        super("transaction_inactive");
        this.name = "TransactionInactiveError";
        this.code = "transaction_inactive";
    }
}
