export const REGISTRATION_BONUS_TOKENS : number = 350;
export const MONTHLY_BONUS_TOKENS : number = 100;
export const MONTHLY_BONUS_LIMIT : number = 300;

export const TOKEN_COST_UPLOAD : number = 2;
export const TOKEN_COST_SOCIAL_TEXT : number = 10;
export const TOKEN_COST_EXPORT : number = 1;
export const TOKEN_COST_LISTEN_PER_MINUTE : number = 5;
export const TOKEN_COST_HIGHLIGHT_ANALYZE : number = 2;
export const TOKEN_COST_HIGHLIGHT_EXPORT : number = 3;
export const TOKEN_COST_OLD_VIDEO_STORAGE_DAILY : number = 1;

export const TOKEN_ENTRY_TYPE_REGISTRATION : string = 'registration_bonus';
export const TOKEN_ENTRY_TYPE_MONTHLY : string = 'monthly_bonus';
export const TOKEN_ENTRY_TYPE_UPLOAD : string = 'video_upload';
export const TOKEN_ENTRY_TYPE_SOCIAL_TEXT : string = 'social_text_generate';
export const TOKEN_ENTRY_TYPE_EXPORT : string = 'video_export';
export const TOKEN_ENTRY_TYPE_LISTEN : string = 'video_listen';
export const TOKEN_ENTRY_TYPE_HIGHLIGHT_ANALYZE : string = 'highlight_analyze';
export const TOKEN_ENTRY_TYPE_HIGHLIGHT_EXPORT : string = 'highlight_export';
export const TOKEN_ENTRY_TYPE_OLD_VIDEO_STORAGE : string = 'old_video_storage';
export const TOKEN_ENTRY_TYPE_ADMIN_ADJUSTMENT : string = 'admin_adjustment';

/**
 * Whisper lehallgatás token költség számítás: minden megkezdett perc 5 token.
 * @param durationSeconds Videó hossza másodpercben.
 * @returns Szükséges token mennyiség.
 */
export function calculateListenTokens(durationSeconds : number) : number {
  const durationMinutes : number = Math.max(1, Math.ceil(Math.max(0, durationSeconds) / 60));
  return durationMinutes * TOKEN_COST_LISTEN_PER_MINUTE;
}
