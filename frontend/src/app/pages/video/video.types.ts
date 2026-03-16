export interface SubtitlePresetForm {
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
}

export interface SubtitleCue {
  startSeconds : number;
  endSeconds : number;
  text : string;
}
