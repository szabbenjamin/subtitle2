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
}
