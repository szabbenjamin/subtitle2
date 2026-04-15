import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-guide-page',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './guide.page.html',
  styleUrl: './guide.page.scss',
})
export class GuidePage {}
