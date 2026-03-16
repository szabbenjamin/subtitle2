export interface AuthTokenResponse {
  accessToken : string;
}

export interface UserProfile {
  id : number;
  email : string;
  isEmailVerified : boolean;
  tokenBalance : number;
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
