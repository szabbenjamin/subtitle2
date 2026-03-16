import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { SubtitlePreset } from '../models/api.models';

interface CreateSubtitlePresetPayload {
  name : string;
}

export interface UpdateSubtitlePresetPayload {
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

@Injectable({ providedIn: 'root' })
export class SubtitlePresetService {
  public constructor(private readonly httpClient : HttpClient) {}

  /**
   * Felhasználó sablonjainak lekérése.
   * @returns Sablon lista.
   */
  public list() : Observable<SubtitlePreset[]> {
    return this.httpClient.get<SubtitlePreset[]>('/api/subtitle-presets');
  }

  /**
   * Új sablon létrehozása.
   * @param payload Létrehozási adatok.
   * @returns Létrejött sablon.
   */
  public create(payload : CreateSubtitlePresetPayload) : Observable<SubtitlePreset> {
    return this.httpClient.post<SubtitlePreset>('/api/subtitle-presets', payload);
  }

  /**
   * Sablon mentése.
   * @param id Sablon azonosító.
   * @param payload Mentendő sablon adatok.
   * @returns Frissített sablon.
   */
  public update(id : number, payload : UpdateSubtitlePresetPayload) : Observable<SubtitlePreset> {
    return this.httpClient.patch<SubtitlePreset>(`/api/subtitle-presets/${id}`, payload);
  }

  /**
   * Sablon törlése.
   * @param id Sablon azonosító.
   * @returns Siker jelzés.
   */
  public remove(id : number) : Observable<{ success : boolean }> {
    return this.httpClient.delete<{ success : boolean }>(`/api/subtitle-presets/${id}`);
  }
}
