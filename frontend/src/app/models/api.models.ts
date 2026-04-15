export interface AuthTokenResponse {
  accessToken : string;
}

export interface UserProfile {
  id : number;
  email : string;
  isEmailVerified : boolean;
  tokenBalance : number;
  whisperModel : string;
  whisperLanguage : string;
  wordsPerLine : number;
  createdAt : string;
}

export interface VideoListItem {
  id : number;
  originalFileName : string;
  durationSeconds : number;
  fileSizeBytes : number;
  createdAt : string;
  isHidden : boolean;
  processingStatus : string;
  thumbnailUrl : string;
}

export interface VideoDetails extends VideoListItem {
  subtitleText : string;
  listenRequested : boolean;
  mediaUrl : string;
  subtitlePresetId : number | null;
  socialTextCombined : string;
  whisperModel : string;
  whisperLanguage : string;
  wordsPerLine : number;
}

export type VideoIngestSourceType = 'file' | 'youtube';
export type VideoIngestStatus = 'queued' | 'uploading' | 'downloading' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface VideoIngestTask {
  id : number;
  sourceType : VideoIngestSourceType;
  externalId : string;
  displayTitle : string;
  status : VideoIngestStatus;
  progressPercent : number;
  stageMessage : string;
  errorMessage : string;
  videoId : number | null;
  createdAt : string;
  updatedAt : string;
}

export type HighlightMode = 'balanced' | 'funny' | 'emotional' | 'informative' | 'dynamic';

export interface HighlightFeatureReason {
  key : string;
  label : string;
  value : number;
  normalized : number;
  weight : number;
  contribution : number;
  explanation : string;
}

export interface VideoHighlightClip {
  id : number;
  analysisId : number;
  rank : number;
  score : number;
  startSeconds : number;
  endSeconds : number;
  durationSeconds : number;
  screenshotUrl : string;
  transcriptSnippet : string;
  reasonSummary : string;
  reasons : HighlightFeatureReason[];
  feedbackStatus : string;
  feedbackNote : string;
  createdAt : string;
}

export interface VideoHighlightAnalysis {
  id : number;
  videoId : number;
  mode : HighlightMode;
  status : string;
  stageCode : string;
  stageMessage : string;
  progressPercent : number;
  requiresWhisper : boolean;
  errorMessage : string;
  createdAt : string;
  updatedAt : string;
  completedAt : string | null;
  clips : VideoHighlightClip[];
}

export interface HighlightExportedVideo {
  id : number;
  originalFileName : string;
  mediaUrl : string;
  durationSeconds : number;
  createdAt : string;
}

export interface SubtitlePreset {
  id : number;
  name : string;
  fontName : string;
  fontSize : number;
  primaryColour : string;
  secondaryColour : string;
  outlineColour : string;
  backColour : string;
  bold : boolean;
  italic : boolean;
  underline : boolean;
  strikeOut : boolean;
  scaleX : number;
  scaleY : number;
  spacing : number;
  angle : number;
  borderStyle : number;
  outline : number;
  shadow : number;
  alignment : number;
  marginL : number;
  marginR : number;
  marginV : number;
  encoding : string;
  createdAt : string;
  updatedAt : string;
}

export interface SocialTextResult {
  title : string;
  hashtags : string[];
  combinedText : string;
}

export interface TokenBalanceResponse {
  tokenBalance : number;
}

export interface TokenHistoryItem {
  id : number;
  delta : number;
  balanceAfter : number;
  type : string;
  description : string;
  createdAt : string;
}

export interface AdminUserTokenItem {
  id : number;
  email : string;
  tokenBalance : number;
  isEmailVerified : boolean;
  createdAt : string;
}
