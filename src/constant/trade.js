
// Trade Offer Type

export const TRADE_TYPE_DEPOSIT   = 'DEPOSIT'
export const TRADE_TYPE_WITHDRAW  = 'WITHDRAW'
export const TRADE_TYPE_INCOMING  = 'INCOMING'
export const TRADE_TYPE_STORAGE   = 'STORAGE'
export const TRADE_TYPE_VIRTUAL   = 'VIRTUAL'

// Trade Offer States

export const TRADE_STATE_QUEUED       = 'QUEUED'
export const TRADE_STATE_CONFIRM      = 'WAITING_CONFIRMATION'
export const TRADE_STATE_SENT         = 'SENT'
export const TRADE_STATE_PENDING      = 'PENDING'
export const TRADE_STATE_ACCEPTED     = 'ACCEPTED'
export const TRADE_STATE_DECLINED     = 'DECLINED'
export const TRADE_STATE_ERROR        = 'ERROR'
export const TRADE_STATE_ESCROW       = 'ESCROW'

// Trade Item States

export const TRADE_ITEM_STATE_PENDING   = 'PENDING'
export const TRADE_ITEM_STATE_INSERTED  = 'INSERTED'

// Trade Verification States

export const TRADE_VERIFICATION_STEP_PENDING      = 'PENDING'
export const TRADE_VERIFICATION_STEP_APPROVED     = 'APPROVED'
export const TRADE_VERIFICATION_STEP_DENIED       = 'DENIED'
