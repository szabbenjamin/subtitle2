export interface AuthTokenResponse {
  accessToken : string;
}

export interface UserProfile {
  id : number;
  email : string;
  isEmailVerified : boolean;
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
