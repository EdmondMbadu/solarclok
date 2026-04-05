import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  PLATFORM_ID,
  ViewChild,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

interface City {
  id: string;
  name: string;
  countryCode: string;
  country: string;
  admin1: string;
  lat: number;
  lng: number;
  utc: number;
  searchText: string;
}

type DayPhase = 'day' | 'twilight' | 'night';

interface CitySnapshot {
  city: City;
  localDate: Date;
  dayOfYear: number;
  decimalHours: number;
  elevation: number;
  dayLength: number;
  sunrise: number;
  sunset: number;
  solarNoon: number;
  localSolarTime: number;
  season: string;
  phase: DayPhase;
}

interface MarkerBundle {
  group: THREE.Group;
  beam: THREE.Mesh;
  dot: THREE.Mesh;
  ring: THREE.Mesh;
}

type WorldCityRow = [number, string, number, number, string, string];

const TAU = Math.PI * 2;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const EARTH_TILT = THREE.MathUtils.degToRad(-23.44);
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const COUNTRY_NAMES =
  typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : undefined;

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function approximateUtcOffset(countryCode: string, lng: number): number {
  const countryOverrides: Record<string, number> = {
    AF: 4.5,
    IN: 5.5,
    IR: 3.5,
    LK: 5.5,
    MM: 6.5,
    NP: 5.75
  };

  if (countryCode in countryOverrides) {
    return countryOverrides[countryCode];
  }

  return clamp(Math.round(lng / 15), -12, 14);
}

function createCityId(name: string, countryCode: string, lat: number, lng: number): string {
  return `${countryCode}-${normalizeSearchText(name).replace(/\s+/g, '-')}-${lat.toFixed(4)}-${lng.toFixed(4)}`;
}

function createCity(
  name: string,
  countryCode: string,
  lat: number,
  lng: number,
  admin1 = '',
  utcOverride?: number
): City {
  const country = COUNTRY_NAMES?.of(countryCode) ?? countryCode;
  return {
    id: createCityId(name, countryCode, lat, lng),
    name,
    countryCode,
    country,
    admin1,
    lat,
    lng,
    utc: utcOverride ?? approximateUtcOffset(countryCode, lng),
    searchText: normalizeSearchText([name, country, countryCode, admin1].join(' '))
  };
}

function createCityFromRow([, name, lat, lng, countryCode, admin1]: WorldCityRow): City {
  return createCity(name, countryCode, lat, lng, admin1);
}

const DEFAULT_CITIES: City[] = [
  createCity('Las Vegas', 'US', 36.1699, -115.1398, 'Nevada', -7),
  createCity('New York', 'US', 40.7128, -74.006, 'New York', -4),
  createCity('London', 'GB', 51.5072, -0.1276, 'England', 1),
  createCity('Tokyo', 'JP', 35.6764, 139.65, 'Tokyo', 9),
  createCity('Sydney', 'AU', -33.8688, 151.2093, 'New South Wales', 10)
];

const DISCOVERY_CITIES: City[] = [
  createCity('Reykjavik', 'IS', 64.1466, -21.9426),
  createCity('Nuuk', 'GL', 64.1835, -51.7216),
  createCity('Ushuaia', 'AR', -54.8019, -68.303),
  createCity('Longyearbyen', 'SJ', 78.2232, 15.6469),
  createCity('Apia', 'WS', -13.8333, -171.7667),
  createCity('Alice Springs', 'AU', -23.698, 133.8807, 'Northern Territory'),
  createCity('Windhoek', 'NA', -22.57, 17.0836),
  createCity('Invercargill', 'NZ', -46.4132, 168.3538),
  createCity('Lima', 'PE', -12.0464, -77.0428),
  createCity('Tromso', 'NO', 69.6492, 18.9553),
  createCity('Anchorage', 'US', 61.2181, -149.9003, 'Alaska'),
  createCity('Marrakesh', 'MA', 31.6295, -7.9811)
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeHour(hours: number): number {
  const wrapped = hours % 24;
  return wrapped < 0 ? wrapped + 24 : wrapped;
}

function normalizeLongitude(lng: number): number {
  const wrapped = ((lng + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

function cityLocalDate(referenceUtcMs: number, city: City): Date {
  return new Date(referenceUtcMs + city.utc * HOUR_MS);
}

function dayOfYearFromDate(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const current = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return clamp(Math.round((current - start) / 86_400_000), 1, 365);
}

function formatMonthDay(date: Date): string {
  return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function formatDateLabel(date: Date): string {
  return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

function formatClock24(decimalHours: number): string {
  const hours = Math.floor(normalizeHour(decimalHours));
  const minutes = Math.floor((normalizeHour(decimalHours) - hours) * 60 + 0.0001);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function formatClock12(decimalHours: number): string {
  const normalized = normalizeHour(decimalHours);
  const hours = Math.floor(normalized);
  const minutes = Math.floor((normalized - hours) * 60 + 0.0001);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const twelveHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelveHour}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

function formatUtcOffset(utc: number): string {
  const sign = utc >= 0 ? '+' : '-';
  const absolute = Math.abs(utc);
  const hours = Math.floor(absolute);
  const minutes = Math.round((absolute - hours) * 60);
  return minutes === 0
    ? `UTC ${sign} ${hours}`
    : `UTC ${sign} ${hours}:${String(minutes).padStart(2, '0')}`;
}

function formatLatitude(lat: number): string {
  return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
}

function formatLongitude(lng: number): string {
  return `${Math.abs(lng).toFixed(1)}°${lng >= 0 ? 'E' : 'W'}`;
}

function formatCoordinates(city: City): string {
  return `${Math.abs(city.lat).toFixed(2)}°${city.lat >= 0 ? 'N' : 'S'} · ${Math.abs(city.lng).toFixed(2)}°${city.lng >= 0 ? 'E' : 'W'}`;
}

function solarDeclination(dayOfYear: number): number {
  return 23.44 * Math.sin(((TAU / 365) * (dayOfYear - 81)));
}

function dayLengthForCity(city: City, dayOfYear: number): number {
  const lat = THREE.MathUtils.degToRad(city.lat);
  const declination = THREE.MathUtils.degToRad(solarDeclination(dayOfYear));
  const cosineHourAngle = -Math.tan(lat) * Math.tan(declination);

  if (cosineHourAngle >= 1) {
    return 0;
  }

  if (cosineHourAngle <= -1) {
    return 24;
  }

  return (2 * THREE.MathUtils.radToDeg(Math.acos(cosineHourAngle))) / 15;
}

function solarMetricsForCity(city: City, dayOfYear: number, localClockHours: number) {
  const dayLength = dayLengthForCity(city, dayOfYear);
  const longitudeCorrection = city.lng / 15 - city.utc;
  const solarNoon = normalizeHour(12 - longitudeCorrection);
  const sunrise = normalizeHour(solarNoon - dayLength / 2);
  const sunset = normalizeHour(solarNoon + dayLength / 2);
  const localSolarTime = normalizeHour(localClockHours + longitudeCorrection);
  const hourAngle = THREE.MathUtils.degToRad((localSolarTime - 12) * 15);
  const latitude = THREE.MathUtils.degToRad(city.lat);
  const declination = THREE.MathUtils.degToRad(solarDeclination(dayOfYear));
  const elevation =
    THREE.MathUtils.radToDeg(
      Math.asin(
        Math.sin(latitude) * Math.sin(declination) +
          Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle)
      )
    );

  return {
    dayLength,
    sunrise,
    sunset,
    solarNoon,
    localSolarTime,
    elevation: Math.round(elevation * 10) / 10
  };
}

function seasonForCity(city: City, dayOfYear: number): string {
  const northernHemisphere = city.lat >= 0;

  if (dayOfYear < 80 || dayOfYear >= 355) {
    return northernHemisphere ? 'Winter' : 'Summer';
  }

  if (dayOfYear < 172) {
    return northernHemisphere ? 'Spring' : 'Autumn';
  }

  if (dayOfYear < 266) {
    return northernHemisphere ? 'Summer' : 'Winter';
  }

  return northernHemisphere ? 'Autumn' : 'Spring';
}

function phaseFromElevation(elevation: number): DayPhase {
  if (elevation > 2) {
    return 'day';
  }

  if (elevation > -6) {
    return 'twilight';
  }

  return 'night';
}

function snapshotForCity(city: City, referenceUtcMs: number): CitySnapshot {
  const localDate = cityLocalDate(referenceUtcMs, city);
  const dayOfYear = dayOfYearFromDate(localDate);
  const decimalHours = localDate.getUTCHours() + localDate.getUTCMinutes() / 60;
  const solar = solarMetricsForCity(city, dayOfYear, decimalHours);

  return {
    city,
    localDate,
    dayOfYear,
    decimalHours,
    elevation: solar.elevation,
    dayLength: solar.dayLength,
    sunrise: solar.sunrise,
    sunset: solar.sunset,
    solarNoon: solar.solarNoon,
    localSolarTime: solar.localSolarTime,
    season: seasonForCity(city, dayOfYear),
    phase: phaseFromElevation(solar.elevation)
  };
}

function searchCities(cities: City[], selectedIds: Set<string>, query: string): City[] {
  if (!query) {
    return DISCOVERY_CITIES.filter((city) => !selectedIds.has(city.id));
  }

  const tokens = query.split(/\s+/).filter(Boolean);
  const exact: City[] = [];
  const prefix: City[] = [];
  const contains: City[] = [];

  for (const city of cities) {
    if (selectedIds.has(city.id)) {
      continue;
    }

    if (!tokens.every((token) => city.searchText.includes(token))) {
      continue;
    }

    const cityName = normalizeSearchText(city.name);

    if (cityName === query) {
      exact.push(city);
      continue;
    }

    if (cityName.startsWith(query) || city.searchText.startsWith(query)) {
      prefix.push(city);
      continue;
    }

    contains.push(city);
  }

  return [...exact, ...prefix, ...contains].slice(0, 12);
}

function latLngToVector(lat: number, lng: number, radius: number): THREE.Vector3 {
  const latitude = THREE.MathUtils.degToRad(lat);
  const longitude = THREE.MathUtils.degToRad(lng);

  return new THREE.Vector3(
    radius * Math.cos(latitude) * Math.sin(longitude),
    radius * Math.sin(latitude),
    radius * Math.cos(latitude) * Math.cos(longitude)
  );
}

function pseudoRandom(seed: number): number {
  return (Math.sin(seed * 127.1) * 43_758.5453) % 1;
}

function pseudoRandomPositive(seed: number): number {
  return Math.abs(pseudoRandom(seed));
}

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class App implements AfterViewInit, OnDestroy {
  @ViewChild('sceneHost') private sceneHost?: ElementRef<HTMLDivElement>;

  protected readonly citySearch = signal('');
  protected readonly isModalOpen = signal(false);
  protected readonly isPlaying = signal(false);
  protected readonly selectedCities = signal(DEFAULT_CITIES);
  protected readonly activeCityIndex = signal(0);
  protected readonly worldCities = signal<City[]>([]);
  protected readonly cityCatalogStatus = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');

  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  private readonly initialCity = this.selectedCities()[0];
  private readonly initialMoment = cityLocalDate(Date.now(), this.initialCity);

  protected readonly hourOfDay = signal(
    this.initialMoment.getUTCHours() * 60 + this.initialMoment.getUTCMinutes()
  );
  protected readonly dayOfYear = signal(dayOfYearFromDate(this.initialMoment));

  protected readonly activeCity = computed(
    () => this.selectedCities()[this.activeCityIndex()] ?? this.selectedCities()[0]
  );
  protected readonly referenceUtcMs = computed(() => {
    const activeCity = this.activeCity();
    const baseDate = Date.UTC(this.initialMoment.getUTCFullYear(), 0, this.dayOfYear(), 0, 0, 0, 0);
    return baseDate + this.hourOfDay() * MINUTE_MS - activeCity.utc * HOUR_MS;
  });
  protected readonly citySnapshots = computed(() =>
    this.selectedCities().map((city) => snapshotForCity(city, this.referenceUtcMs()))
  );
  protected readonly activeSnapshot = computed(
    () => this.citySnapshots()[this.activeCityIndex()] ?? this.citySnapshots()[0]
  );
  protected readonly filteredCities = computed(() =>
    searchCities(
      this.worldCities(),
      new Set(this.selectedCities().map((city) => city.id)),
      normalizeSearchText(this.citySearch())
    )
  );
  protected readonly cityCatalogSummary = computed(() => {
    const status = this.cityCatalogStatus();

    if (status === 'loading') {
      return 'Loading 154,694 world cities...';
    }

    if (status === 'ready') {
      return `${this.worldCities().length.toLocaleString()} cities searchable. UTC offsets for catalog cities are approximate.`;
    }

    if (status === 'error') {
      return 'City catalog could not be loaded.';
    }

    return 'Search the full world catalog, including remote cities.';
  });
  protected readonly dateLabel = computed(() => formatDateLabel(this.activeSnapshot().localDate));
  protected readonly dayLabel = computed(
    () => `${WEEKDAY_NAMES[this.activeSnapshot().localDate.getUTCDay()]} · ${this.activeCity().country}`
  );
  protected readonly hourLabel = computed(() => formatClock24(this.activeSnapshot().decimalHours));
  protected readonly seasonSliderLabel = computed(() => formatMonthDay(this.activeSnapshot().localDate));
  protected readonly dayLengthLabel = computed(() => {
    const dayLength = this.activeSnapshot().dayLength;
    const hours = Math.floor(dayLength);
    const minutes = Math.round((dayLength - hours) * 60);
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  });
  protected readonly sunArc = computed(() => {
    const snapshot = this.activeSnapshot();
    const progress =
      snapshot.dayLength >= 24
        ? normalizeHour(snapshot.decimalHours) / 24
        : snapshot.dayLength <= 0
          ? 0
          : clamp((snapshot.decimalHours - snapshot.sunrise) / snapshot.dayLength, 0, 1);
    const inverse = 1 - progress;
    const x = inverse * inverse * 8 + 2 * inverse * progress * 90 + progress * progress * 172;
    const y = inverse * inverse * 54 + 2 * inverse * progress * 6 + progress * progress * 54;

    return {
      progress,
      x,
      y,
      dashOffset: 184 - progress * 184
    };
  });
  protected readonly subsolarPoint = computed(() => {
    const utcDate = new Date(this.referenceUtcMs());
    const utcHours = utcDate.getUTCHours() + utcDate.getUTCMinutes() / 60;
    const latitude = solarDeclination(dayOfYearFromDate(utcDate));
    const longitude = normalizeLongitude(15 * (12 - utcHours));

    return { lat: latitude, lng: longitude };
  });
  protected readonly orbitalMarker = computed(() => {
    const angle = ((this.activeSnapshot().dayOfYear - 80) / 365) * TAU;
    return {
      x: 77 + Math.cos(angle) * 48,
      y: 54 + Math.sin(angle) * 20
    };
  });
  protected readonly dayShare = computed(() =>
    clamp(this.activeSnapshot().dayLength / 24, 0.06, 0.94)
  );
  protected readonly cityStatus = computed(() => {
    const snapshot = this.activeSnapshot();

    if (snapshot.phase === 'day') {
      return `Sunlit hemisphere · altitude ${snapshot.elevation.toFixed(1)}°`;
    }

    if (snapshot.phase === 'twilight') {
      return `Blue hour transition · altitude ${snapshot.elevation.toFixed(1)}°`;
    }

    return `Night side glow · sun ${Math.abs(snapshot.elevation).toFixed(1)}° below`;
  });

  protected readonly cityCountLabel = computed(() => `${this.selectedCities().length} tracked cities`);
  protected readonly utcOffsetLabel = computed(() => formatUtcOffset(this.activeCity().utc));
  protected readonly coordinateLabel = computed(() => formatCoordinates(this.activeCity()));
  protected readonly localSolarTimeLabel = computed(() => formatClock12(this.activeSnapshot().localSolarTime));
  protected readonly solarNoonLabel = computed(() => formatClock12(this.activeSnapshot().solarNoon));

  private renderer?: THREE.WebGLRenderer;
  private composer?: EffectComposer;
  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private controls?: OrbitControls;
  private resizeObserver?: ResizeObserver;
  private animationFrameId?: number;
  private playbackTimer?: number;
  private sceneReady = false;
  private earthSphere?: THREE.Mesh;
  private cloudsSphere?: THREE.Mesh;
  private atmosphereSphere?: THREE.Mesh;
  private starField?: THREE.Points;
  private sunMesh?: THREE.Mesh;
  private sunHalo?: THREE.Mesh;
  private sunLight?: THREE.DirectionalLight;
  private moonOrbiter?: THREE.Group;
  private focusGroup?: THREE.Group;
  private tiltGroup?: THREE.Group;
  private markerRoot?: THREE.Group;
  private currentFocusX = 0;
  private currentFocusY = 0;
  private targetFocusX = 0;
  private targetFocusY = 0;
  private readonly markerBundles = new Map<string, MarkerBundle>();
  private readonly tempVector = new THREE.Vector3();

  private readonly syncSceneEffect = effect(() => {
    const activeCity = this.activeCity();
    const markers = this.citySnapshots();
    const subsolarPoint = this.subsolarPoint();

    if (!this.sceneReady) {
      return;
    }

    this.syncMarkers(markers, activeCity.id);
    this.targetFocusY = -THREE.MathUtils.degToRad(activeCity.lng);
    this.targetFocusX = THREE.MathUtils.degToRad(clamp(activeCity.lat * 0.68, -48, 48));
    this.updateSunTarget(subsolarPoint.lat, subsolarPoint.lng);
  });

  protected trackByCity(_: number, snapshot: CitySnapshot): string {
    return snapshot.city.id;
  }

  protected updateHour(value: string): void {
    this.hourOfDay.set(Number(value));
  }

  protected updateDayOfYear(value: string): void {
    this.dayOfYear.set(Number(value));
  }

  protected togglePlayback(): void {
    if (this.isPlaying()) {
      this.stopPlayback();
      return;
    }

    this.isPlaying.set(true);
    this.playbackTimer = window.setInterval(() => {
      this.shiftTimeline(8);
    }, 120);
  }

  protected selectCity(index: number): void {
    const utcMs = this.referenceUtcMs();
    this.activeCityIndex.set(index);
    this.reanchorMoment(utcMs, this.activeCity());
  }

  protected removeCity(index: number, event: Event): void {
    event.stopPropagation();

    if (this.selectedCities().length === 1) {
      return;
    }

    const utcMs = this.referenceUtcMs();
    const nextCities = this.selectedCities().filter((_, currentIndex) => currentIndex !== index);
    const nextActiveIndex = clamp(
      index < this.activeCityIndex() ? this.activeCityIndex() - 1 : this.activeCityIndex(),
      0,
      nextCities.length - 1
    );

    this.selectedCities.set(nextCities);
    this.activeCityIndex.set(nextActiveIndex);
    this.reanchorMoment(utcMs, this.activeCity());
  }

  protected openCityModal(): void {
    this.isModalOpen.set(true);
    this.citySearch.set('');
    void this.ensureWorldCatalogLoaded();
  }

  protected closeCityModal(): void {
    this.isModalOpen.set(false);
    this.citySearch.set('');
  }

  protected updateSearch(value: string): void {
    this.citySearch.set(value);
  }

  protected addCity(city: City): void {
    const utcMs = this.referenceUtcMs();
    this.selectedCities.update((current) => [...current, city]);
    this.activeCityIndex.set(this.selectedCities().length - 1);
    this.reanchorMoment(utcMs, this.activeCity());
    this.closeCityModal();
  }

  protected phaseLabel(snapshot: CitySnapshot): string {
    if (snapshot.phase === 'day') {
      return 'Sunlit';
    }

    if (snapshot.phase === 'twilight') {
      return 'Twilight';
    }

    return 'Night';
  }

  protected phaseClass(snapshot: CitySnapshot): string {
    return `city-card--${snapshot.phase}`;
  }

  protected formatCardTime(snapshot: CitySnapshot): string {
    return formatClock24(snapshot.decimalHours);
  }

  protected formatCardDay(snapshot: CitySnapshot): string {
    return `${WEEKDAY_NAMES[snapshot.localDate.getUTCDay()]} · ${snapshot.city.country}`;
  }

  protected formatCardLabel(snapshot: CitySnapshot): string {
    return `${snapshot.city.name} · ${formatUtcOffset(snapshot.city.utc)}`;
  }

  protected formatRiseSet(hours: number): string {
    return formatClock12(hours);
  }

  protected formatSubsolarPoint(): string {
    const point = this.subsolarPoint();
    return `${formatLatitude(point.lat)}, ${formatLongitude(point.lng)}`;
  }

  protected formatTiltLabel(): string {
    return '23.44°';
  }

  protected formatCityOptionMeta(city: City): string {
    return `${city.country} · ${formatCoordinates(city)}`;
  }

  protected formatUtcOffset(utc: number): string {
    return formatUtcOffset(utc);
  }

  protected formatLatitude(lat: number): string {
    return formatLatitude(lat);
  }

  protected formatOrbitSeason(): string {
    return this.activeSnapshot().season;
  }

  protected formatDayShare(): string {
    return `${Math.round(this.dayShare() * 100)}% daylight`;
  }

  protected formatElevation(): string {
    return `${this.activeSnapshot().elevation.toFixed(1)}°`;
  }

  protected formatHemisphere(): string {
    return `${this.activeCity().lat >= 0 ? 'Northern' : 'Southern'} hemisphere`;
  }

  protected formatLocationHeader(): string {
    return `${this.activeCity().name}, ${this.activeCity().country}`;
  }

  ngAfterViewInit(): void {
    if (!this.isBrowser || !this.sceneHost) {
      return;
    }

    this.initScene(this.sceneHost.nativeElement);
  }

  ngOnDestroy(): void {
    this.stopPlayback();

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }

    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    this.composer?.dispose();
    this.renderer?.dispose();

    this.markerBundles.forEach(({ group }) => {
      group.traverse((object: THREE.Object3D) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose?.();

        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((material: THREE.Material) => material.dispose());
        } else {
          mesh.material?.dispose?.();
        }
      });
    });
  }

  private stopPlayback(): void {
    this.isPlaying.set(false);

    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = undefined;
    }
  }

  private shiftTimeline(deltaMinutes: number): void {
    const nextUtcMs = this.referenceUtcMs() + deltaMinutes * MINUTE_MS;
    this.reanchorMoment(nextUtcMs, this.activeCity());
  }

  private async ensureWorldCatalogLoaded(): Promise<void> {
    if (!this.isBrowser || this.cityCatalogStatus() === 'loading' || this.cityCatalogStatus() === 'ready') {
      return;
    }

    try {
      this.cityCatalogStatus.set('loading');
      const response = await fetch('data/world-cities.min.json');

      if (!response.ok) {
        throw new Error(`Failed to load catalog: ${response.status}`);
      }

      const rows = (await response.json()) as WorldCityRow[];
      const cities = rows
        .map((row) => createCityFromRow(row))
        .sort((left, right) =>
          left.name.localeCompare(right.name) || left.country.localeCompare(right.country)
        );

      this.worldCities.set(cities);
      this.cityCatalogStatus.set('ready');
    } catch {
      this.cityCatalogStatus.set('error');
    }
  }

  private reanchorMoment(referenceUtcMs: number, city: City): void {
    const localDate = cityLocalDate(referenceUtcMs, city);
    this.dayOfYear.set(dayOfYearFromDate(localDate));
    this.hourOfDay.set(localDate.getUTCHours() * 60 + localDate.getUTCMinutes());
  }

  private initScene(host: HTMLDivElement): void {
    try {
      const width = host.clientWidth || 960;
      const height = host.clientHeight || 720;

      this.scene = new THREE.Scene();
      this.scene.fog = new THREE.FogExp2('#04111f', 0.028);

      this.camera = new THREE.PerspectiveCamera(34, width / height, 0.1, 120);
      this.camera.position.set(0, 0.2, 5.1);

      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.setSize(width, height);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      host.appendChild(this.renderer.domElement);

      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.8, 0.9, 0.18);
      bloom.threshold = 0.2;
      bloom.radius = 0.72;
      bloom.strength = 0.78;
      this.composer.addPass(bloom);

      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enablePan = false;
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.05;
      this.controls.minDistance = 3.4;
      this.controls.maxDistance = 6.4;
      this.controls.target.set(0, 0, 0);

      this.focusGroup = new THREE.Group();
      this.tiltGroup = new THREE.Group();
      this.markerRoot = new THREE.Group();
      this.focusGroup.add(this.tiltGroup);
      this.tiltGroup.rotation.z = EARTH_TILT;
      this.tiltGroup.add(this.markerRoot);
      this.scene.add(this.focusGroup);

      this.createBackdropObjects();
      this.createGlobeObjects();
      this.createLighting();
      this.createMarkers();

      this.resizeObserver = new ResizeObserver(() => this.handleResize(host));
      this.resizeObserver.observe(host);

      this.sceneReady = true;
      this.syncMarkers(this.citySnapshots(), this.activeCity().id);
      this.updateSunTarget(this.subsolarPoint().lat, this.subsolarPoint().lng);
      this.animate();
    } catch {
      this.sceneReady = false;
    }
  }

  private createBackdropObjects(): void {
    if (!this.scene) {
      return;
    }

    const starGeometry = new THREE.BufferGeometry();
    const starCount = 2200;
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);

    for (let index = 0; index < starCount; index += 1) {
      const radius = 11 + pseudoRandomPositive(index + 2) * 20;
      const theta = pseudoRandomPositive(index * 3.17) * TAU;
      const phi = Math.acos(2 * pseudoRandomPositive(index * 7.91) - 1);
      const sinPhi = Math.sin(phi);
      const baseIndex = index * 3;
      positions[baseIndex] = radius * sinPhi * Math.cos(theta);
      positions[baseIndex + 1] = radius * Math.cos(phi);
      positions[baseIndex + 2] = radius * sinPhi * Math.sin(theta);

      const warm = pseudoRandomPositive(index * 5.31);
      colors[baseIndex] = THREE.MathUtils.lerp(0.55, 1, warm);
      colors[baseIndex + 1] = THREE.MathUtils.lerp(0.62, 0.9, warm);
      colors[baseIndex + 2] = THREE.MathUtils.lerp(0.8, 1, warm);
    }

    starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    starGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    this.starField = new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({
        size: 0.06,
        transparent: true,
        opacity: 0.92,
        vertexColors: true,
        sizeAttenuation: true
      })
    );
    this.scene.add(this.starField);

    const orbitalRing = new THREE.Mesh(
      new THREE.TorusGeometry(2.35, 0.008, 12, 180),
      new THREE.MeshBasicMaterial({
        color: '#5bc0ff',
        transparent: true,
        opacity: 0.18
      })
    );
    orbitalRing.rotation.x = THREE.MathUtils.degToRad(70);
    orbitalRing.rotation.y = THREE.MathUtils.degToRad(26);
    this.scene.add(orbitalRing);

    this.moonOrbiter = new THREE.Group();
    this.moonOrbiter.rotation.x = orbitalRing.rotation.x;
    this.moonOrbiter.rotation.y = orbitalRing.rotation.y;
    const moon = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 18, 18),
      new THREE.MeshStandardMaterial({
        color: '#f7fbff',
        emissive: '#c7dcff',
        emissiveIntensity: 0.28,
        roughness: 0.9
      })
    );
    moon.position.set(2.35, 0, 0);
    this.moonOrbiter.add(moon);
    this.scene.add(this.moonOrbiter);
  }

  private createGlobeObjects(): void {
    if (!this.tiltGroup) {
      return;
    }

    const surfaceTexture = this.createEarthSurfaceTexture();
    const cloudTexture = this.createCloudTexture();
    const nightTexture = this.createNightTexture();

    this.earthSphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 96, 96),
      new THREE.MeshPhysicalMaterial({
        map: surfaceTexture,
        emissiveMap: nightTexture,
        emissive: new THREE.Color('#1b2c42'),
        emissiveIntensity: 0.42,
        roughness: 0.82,
        metalness: 0.06,
        clearcoat: 0.22,
        clearcoatRoughness: 0.78
      })
    );

    this.cloudsSphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.235, 72, 72),
      new THREE.MeshStandardMaterial({
        map: cloudTexture,
        transparent: true,
        opacity: 0.45,
        depthWrite: false
      })
    );

    this.atmosphereSphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.32, 72, 72),
      new THREE.MeshBasicMaterial({
        color: '#63c6ff',
        transparent: true,
        opacity: 0.11,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide
      })
    );

    this.tiltGroup.add(this.earthSphere, this.cloudsSphere, this.atmosphereSphere);
  }

  private createLighting(): void {
    if (!this.scene) {
      return;
    }

    this.scene.add(new THREE.AmbientLight('#16304d', 0.52));
    this.scene.add(new THREE.HemisphereLight('#7fd2ff', '#050b13', 0.74));

    const rimLight = new THREE.DirectionalLight('#65c8ff', 1.25);
    rimLight.position.set(-4, 2.2, -3.8);
    this.scene.add(rimLight);

    this.sunLight = new THREE.DirectionalLight('#ffd889', 2.9);
    this.sunLight.position.set(4.6, 1.4, 4.4);
    this.scene.add(this.sunLight);

    this.sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.23, 32, 32),
      new THREE.MeshBasicMaterial({ color: '#ffd97a' })
    );
    this.sunHalo = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 32, 32),
      new THREE.MeshBasicMaterial({
        color: '#ffd37a',
        transparent: true,
        opacity: 0.2,
        blending: THREE.AdditiveBlending
      })
    );

    this.scene.add(this.sunMesh, this.sunHalo);
  }

  private createMarkers(): void {
    this.syncMarkers(this.citySnapshots(), this.activeCity().id);
  }

  private syncMarkers(snapshots: CitySnapshot[], activeCityId: string): void {
    if (!this.markerRoot) {
      return;
    }

    const expectedIds = new Set(snapshots.map((snapshot) => snapshot.city.id));

    this.markerBundles.forEach((bundle, cityId) => {
      if (expectedIds.has(cityId)) {
        return;
      }

      this.markerRoot?.remove(bundle.group);
      this.disposeMarker(bundle);
      this.markerBundles.delete(cityId);
    });

    snapshots.forEach((snapshot, index) => {
      let bundle = this.markerBundles.get(snapshot.city.id);

      if (!bundle) {
        bundle = this.createMarker(snapshot.city);
        this.markerBundles.set(snapshot.city.id, bundle);
        this.markerRoot?.add(bundle.group);
      }

      const active = snapshot.city.id === activeCityId;
      const color =
        snapshot.phase === 'day' ? '#ffbf54' : snapshot.phase === 'twilight' ? '#ff8b43' : '#64b5ff';
      const scale = active ? 1.18 : 0.8 + index * 0.02;
      const opacity = active ? 1 : 0.72;
      const material = bundle.dot.material as THREE.MeshStandardMaterial;
      const ringMaterial = bundle.ring.material as THREE.MeshBasicMaterial;
      const beamMaterial = bundle.beam.material as THREE.MeshBasicMaterial;
      material.color.set(color);
      material.emissive.set(color);
      material.emissiveIntensity = active ? 1 : 0.45;
      ringMaterial.color.set(color);
      ringMaterial.opacity = active ? 0.95 : 0.4;
      beamMaterial.color.set(color);
      beamMaterial.opacity = active ? 0.75 : 0.28;
      bundle.group.scale.setScalar(scale);
      bundle.group.userData['pulseSeed'] = index + 1;
      bundle.group.userData['active'] = active;
      bundle.dot.visible = opacity > 0;
    });
  }

  private createMarker(city: City): MarkerBundle {
    const group = new THREE.Group();
    const outward = latLngToVector(city.lat, city.lng, 1.28);
    group.position.copy(outward);
    group.lookAt(outward.clone().multiplyScalar(2));

    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.01, 0.022, 0.18, 14),
      new THREE.MeshBasicMaterial({ color: '#ffbf54', transparent: true, opacity: 0.7 })
    );
    beam.rotation.x = Math.PI / 2;
    beam.position.z = 0.09;

    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.042, 18, 18),
      new THREE.MeshStandardMaterial({
        color: '#ffbf54',
        emissive: '#ffbf54',
        emissiveIntensity: 0.9,
        roughness: 0.3
      })
    );
    dot.position.z = 0.18;

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.1, 0.006, 10, 40),
      new THREE.MeshBasicMaterial({
        color: '#ffbf54',
        transparent: true,
        opacity: 0.85
      })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.z = 0.12;

    group.add(beam, dot, ring);
    return { group, beam, dot, ring };
  }

  private disposeMarker(bundle: MarkerBundle): void {
    bundle.group.traverse((object: THREE.Object3D) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose?.();

      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((material: THREE.Material) => material.dispose());
      } else {
        mesh.material?.dispose?.();
      }
    });
  }

  private createEarthSurfaceTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d')!;

    const oceanGradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    oceanGradient.addColorStop(0, '#173457');
    oceanGradient.addColorStop(0.35, '#0b2341');
    oceanGradient.addColorStop(1, '#081627');
    ctx.fillStyle = oceanGradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let latitude = 0; latitude <= 12; latitude += 1) {
      const y = (latitude / 12) * canvas.height;
      ctx.strokeStyle = latitude % 6 === 0 ? 'rgba(177, 222, 255, 0.08)' : 'rgba(177, 222, 255, 0.04)';
      ctx.lineWidth = latitude % 6 === 0 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    const landLayers = [
      { color: '#143e34', alpha: 1, scale: 1 },
      { color: '#24684e', alpha: 0.82, scale: 0.82 },
      { color: '#4d7f4a', alpha: 0.36, scale: 0.55 }
    ];
    const landMasses = [
      [-100, 45, 170, 140, -0.3],
      [-60, -15, 80, 110, 0.12],
      [20, 12, 85, 135, -0.08],
      [72, 52, 200, 120, 0.08],
      [132, -24, 76, 56, -0.14],
      [-40, 73, 52, 24, 0.09]
    ];

    landLayers.forEach((layer) => {
      ctx.save();
      ctx.globalAlpha = layer.alpha;
      ctx.fillStyle = layer.color;
      landMasses.forEach(([lng, lat, width, height, rotation], index) => {
        this.paintBlob(ctx, canvas, lng, lat, width * layer.scale, height * layer.scale, rotation + index * 0.03);
      });
      ctx.restore();
    });

    ctx.fillStyle = 'rgba(223, 241, 255, 0.55)';
    ctx.beginPath();
    ctx.ellipse(canvas.width * 0.5, canvas.height * 0.08, canvas.width * 0.26, canvas.height * 0.055, 0, 0, TAU);
    ctx.ellipse(canvas.width * 0.5, canvas.height * 0.92, canvas.width * 0.24, canvas.height * 0.05, 0, 0, TAU);
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }

  private createNightTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#020814';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const seeds = [
      ...DEFAULT_CITIES.map((city, index) => ({
        lng: city.lng,
        lat: city.lat,
        strength: 0.65 + (index % 4) * 0.08
      })),
      { lng: 116.4, lat: 39.9, strength: 0.9 },
      { lng: 77.2, lat: 28.6, strength: 0.88 },
      { lng: 31.2, lat: 30, strength: 0.76 },
      { lng: -3.7, lat: 40.4, strength: 0.72 },
      { lng: 37.6, lat: 55.7, strength: 0.74 },
      { lng: -118.2, lat: 34.1, strength: 0.78 },
      { lng: 151.2, lat: -33.9, strength: 0.7 },
      { lng: 139.7, lat: 35.7, strength: 0.95 }
    ];

    seeds.forEach((seed, index) => {
      const x = ((seed.lng + 180) / 360) * canvas.width;
      const y = ((90 - seed.lat) / 180) * canvas.height;
      const radius = 18 + seed.strength * 30;
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, `rgba(255, 202, 120, ${0.65 * seed.strength})`);
      gradient.addColorStop(0.4, `rgba(255, 178, 96, ${0.26 * seed.strength})`);
      gradient.addColorStop(1, 'rgba(255, 178, 96, 0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, TAU);
      ctx.fill();

      const sparkleCount = 12 + index % 6;
      for (let sparkle = 0; sparkle < sparkleCount; sparkle += 1) {
        const angle = pseudoRandomPositive(index * 20 + sparkle) * TAU;
        const distance = Math.sqrt(pseudoRandomPositive(index * 30 + sparkle * 2)) * radius * 0.75;
        ctx.fillStyle = `rgba(255, 217, 147, ${0.18 + pseudoRandomPositive(index + sparkle) * 0.24})`;
        ctx.beginPath();
        ctx.arc(x + Math.cos(angle) * distance, y + Math.sin(angle) * distance, 1.1, 0, TAU);
        ctx.fill();
      }
    });

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private createCloudTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let index = 0; index < 180; index += 1) {
      const x = pseudoRandomPositive(index * 1.1) * canvas.width;
      const y = pseudoRandomPositive(index * 2.4) * canvas.height;
      const radiusX = 32 + pseudoRandomPositive(index * 3.1) * 120;
      const radiusY = 8 + pseudoRandomPositive(index * 4.7) * 26;
      const rotation = pseudoRandomPositive(index * 5.4) * TAU;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rotation);
      ctx.fillStyle = `rgba(247, 251, 255, ${0.04 + pseudoRandomPositive(index * 6.8) * 0.08})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, radiusX, radiusY, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }

  private paintBlob(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    lng: number,
    lat: number,
    width: number,
    height: number,
    rotation: number
  ): void {
    const x = ((lng + 180) / 360) * canvas.width;
    const y = ((90 - lat) / 180) * canvas.height;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.beginPath();
    ctx.ellipse(0, 0, (width / 360) * canvas.width, (height / 180) * canvas.height, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  private handleResize(host: HTMLDivElement): void {
    if (!this.renderer || !this.camera || !this.composer) {
      return;
    }

    const width = host.clientWidth || 960;
    const height = host.clientHeight || 720;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.composer.setSize(width, height);
  }

  private updateSunTarget(subsolarLat: number, subsolarLng: number): void {
    if (!this.tiltGroup || !this.sunLight || !this.sunMesh || !this.sunHalo) {
      return;
    }

    this.tempVector.copy(latLngToVector(subsolarLat, subsolarLng, 5));
    this.tiltGroup.localToWorld(this.tempVector);
    this.sunLight.position.lerp(this.tempVector, 0.35);
    this.sunMesh.position.lerp(this.tempVector, 0.35);
    this.sunHalo.position.lerp(this.tempVector, 0.35);
  }

  private animate = (): void => {
    if (!this.scene || !this.camera || !this.renderer || !this.composer) {
      return;
    }

    this.animationFrameId = requestAnimationFrame(this.animate);

    this.currentFocusX = THREE.MathUtils.damp(this.currentFocusX, this.targetFocusX, 5.4, 1 / 60);
    this.currentFocusY = THREE.MathUtils.damp(this.currentFocusY, this.targetFocusY, 5.4, 1 / 60);

    if (this.focusGroup) {
      this.focusGroup.rotation.x = this.currentFocusX;
      this.focusGroup.rotation.y = this.currentFocusY;
    }

    if (this.cloudsSphere) {
      this.cloudsSphere.rotation.y += 0.00045;
    }

    if (this.atmosphereSphere) {
      this.atmosphereSphere.rotation.y -= 0.00018;
    }

    if (this.starField) {
      this.starField.rotation.y += 0.00008;
      this.starField.rotation.x += 0.00002;
    }

    if (this.moonOrbiter) {
      this.moonOrbiter.rotation.z += 0.0036;
    }

    const pulse = 1 + Math.sin(performance.now() * 0.0022) * 0.06;
    if (this.sunHalo) {
      this.sunHalo.scale.setScalar(pulse);
    }

    this.markerBundles.forEach((bundle) => {
      const seed = bundle.group.userData['pulseSeed'] as number;
      const active = bundle.group.userData['active'] as boolean;
      const ringScale = active ? 1 + Math.sin(performance.now() * 0.003 + seed) * 0.08 : 1;
      bundle.ring.scale.setScalar(ringScale);
    });

    this.controls?.update();
    this.updateSunTarget(this.subsolarPoint().lat, this.subsolarPoint().lng);
    this.composer.render();
  };
}
