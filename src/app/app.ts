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
import * as topojson from 'topojson-client';
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
  dot: THREE.Mesh;
}

type WorldCityRow = [number, string, number, number, string, string];
type GeoPosition = [number, number];

interface TopologyData {
  objects: {
    countries: object;
  };
}

interface GeoFeatureCollection {
  features: GeoFeature[];
}

interface GeoFeature {
  properties?: {
    name?: string;
  };
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: GeoPosition[][] | GeoPosition[][][];
  };
}

interface GeoMultiLineString {
  coordinates: GeoPosition[][];
}

interface EarthTextureSet {
  color: THREE.CanvasTexture;
  bump: THREE.CanvasTexture;
  roughness: THREE.CanvasTexture;
}

interface CountryLabelPoint {
  name: string;
  lat: number;
  lng: number;
}

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

function formatClock24WithSeconds(date: Date): string {
  return [
    String(date.getUTCHours()).padStart(2, '0'),
    String(date.getUTCMinutes()).padStart(2, '0'),
    String(date.getUTCSeconds()).padStart(2, '0')
  ].join(':');
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

function hashString(value: string): number {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

function directionForLatLngWithFocus(lat: number, lng: number, focusX: number, focusY: number): THREE.Vector3 {
  const direction = latLngToVector(lat, lng, 1);
  const tiltQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, EARTH_TILT));
  const focusQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(focusX, focusY, 0));
  return direction.applyQuaternion(tiltQuaternion).applyQuaternion(focusQuaternion).normalize();
}

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class App implements AfterViewInit, OnDestroy {
  @ViewChild('sceneHost') private sceneHost?: ElementRef<HTMLDivElement>;
  @ViewChild('activeCityOverlay') private activeCityOverlay?: ElementRef<HTMLDivElement>;

  protected readonly citySearch = signal('');
  protected readonly isModalOpen = signal(false);
  protected readonly isPlaying = signal(false);
  protected readonly isLiveMode = signal(true);
  protected readonly selectedCities = signal(DEFAULT_CITIES);
  protected readonly activeCityIndex = signal(0);
  protected readonly worldCities = signal<City[]>([]);
  protected readonly cityCatalogStatus = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  protected readonly liveNowMs = signal(Date.now());

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
    if (this.isLiveMode()) {
      return this.liveNowMs();
    }

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
  protected readonly overlayTimeLabel = computed(() => formatClock24WithSeconds(this.activeSnapshot().localDate));
  protected readonly overlayMetaLabel = computed(
    () => `${WEEKDAY_NAMES[this.activeSnapshot().localDate.getUTCDay()]} · ${this.utcOffsetLabel()}`
  );
  protected readonly timelineHourValue = computed(() => {
    const snapshot = this.activeSnapshot();
    return snapshot.localDate.getUTCHours() * 60 + snapshot.localDate.getUTCMinutes();
  });
  protected readonly timelineDayValue = computed(() => this.activeSnapshot().dayOfYear);
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
  private liveClockTimer?: number;
  private sceneReady = false;
  private earthSphere?: THREE.Mesh;
  private cloudsSphere?: THREE.Mesh;
  private atmosphereSphere?: THREE.Mesh;
  private countryBorderLines?: THREE.LineSegments;
  private starField?: THREE.Points;
  private sunMesh?: THREE.Mesh;
  private sunHalo?: THREE.Mesh;
  private sunCorona?: THREE.Mesh;
  private sunLight?: THREE.DirectionalLight;
  private sunPointLight?: THREE.PointLight;
  private moonOrbiter?: THREE.Group;
  private focusGroup?: THREE.Group;
  private tiltGroup?: THREE.Group;
  private markerRoot?: THREE.Group;
  private currentFocusX = 0;
  private currentFocusY = 0;
  private targetFocusX = 0;
  private targetFocusY = 0;
  private desiredCameraPosition = new THREE.Vector3(0, 0.2, 5.1);
  private autoFramingActive = false;
  private readonly markerBundles = new Map<string, MarkerBundle>();
  private readonly tempVector = new THREE.Vector3();
  private readonly tempVectorB = new THREE.Vector3();

  private readonly syncSceneEffect = effect(() => {
    const activeCity = this.activeCity();
    const markers = this.citySnapshots();
    const subsolarPoint = this.subsolarPoint();

    if (!this.sceneReady) {
      return;
    }

    this.syncMarkers(markers, activeCity.id);
    this.targetFocusY = -THREE.MathUtils.degToRad(activeCity.lng);
    this.targetFocusX = THREE.MathUtils.degToRad(clamp(activeCity.lat, -72, 72));
    this.updateSunTarget(subsolarPoint.lat, subsolarPoint.lng);
  });

  protected trackByCity(_: number, snapshot: CitySnapshot): string {
    return snapshot.city.id;
  }

  protected updateHour(value: string): void {
    this.stopPlayback();
    this.isLiveMode.set(false);
    this.hourOfDay.set(Number(value));
  }

  protected updateDayOfYear(value: string): void {
    this.stopPlayback();
    this.isLiveMode.set(false);
    this.dayOfYear.set(Number(value));
  }

  protected togglePlayback(): void {
    if (this.isPlaying()) {
      this.stopPlayback();
      return;
    }

    this.isLiveMode.set(false);
    this.isPlaying.set(true);
    this.playbackTimer = window.setInterval(() => {
      this.shiftTimeline(8);
    }, 120);
  }

  protected jumpToLive(): void {
    this.stopPlayback();
    const now = Date.now();
    this.liveNowMs.set(now);
    this.reanchorMoment(now, this.activeCity());
    this.isLiveMode.set(true);
  }

  protected selectCity(index: number): void {
    const utcMs = this.referenceUtcMs();
    this.activeCityIndex.set(index);
    this.reanchorMoment(utcMs, this.activeCity());
    this.planCameraForActiveCity(true);
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
    this.planCameraForActiveCity(true);
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
    this.planCameraForActiveCity(true);
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

    this.startLiveClock();
    this.initScene(this.sceneHost.nativeElement);
  }

  ngOnDestroy(): void {
    this.stopPlayback();

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }

    if (this.liveClockTimer) {
      clearInterval(this.liveClockTimer);
      this.liveClockTimer = undefined;
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
    this.isLiveMode.set(false);
    const nextUtcMs = this.referenceUtcMs() + deltaMinutes * MINUTE_MS;
    this.reanchorMoment(nextUtcMs, this.activeCity());
  }

  private startLiveClock(): void {
    if (!this.isBrowser) {
      return;
    }

    const syncLiveMoment = () => {
      const now = Date.now();
      this.liveNowMs.set(now);

      if (this.isLiveMode() && !this.isPlaying()) {
        this.reanchorMoment(now, this.activeCity());
      }
    };

    syncLiveMoment();
    this.liveClockTimer = window.setInterval(syncLiveMoment, 1000);
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

  private async loadGeographyData(): Promise<void> {
    if (!this.isBrowser || !this.earthSphere || !this.tiltGroup) {
      return;
    }

    try {
      const response = await fetch('data/world-countries-10m.json');

      if (!response.ok) {
        throw new Error(`Failed to load geography: ${response.status}`);
      }

      const topology = (await response.json()) as TopologyData;
      const typedTopology = topology as unknown as Parameters<typeof topojson.feature>[0];
      const countries = topojson.feature(
        typedTopology,
        topology.objects.countries as Parameters<typeof topojson.feature>[1]
      ) as unknown as GeoFeatureCollection;
      const borders = topojson.mesh(
        typedTopology,
        topology.objects.countries as Parameters<typeof topojson.mesh>[1],
        (left, right) => left !== right
      ) as unknown as GeoMultiLineString;

      const detailedTexture = this.createDetailedEarthTexture(countries.features);
      const earthMaterial = this.earthSphere.material as THREE.MeshPhysicalMaterial;
      earthMaterial.map = detailedTexture.color;
      earthMaterial.bumpMap = detailedTexture.bump;
      earthMaterial.bumpScale = 0.03;
      earthMaterial.roughnessMap = detailedTexture.roughness;
      earthMaterial.roughness = 0.98;
      earthMaterial.clearcoat = 0.14;
      earthMaterial.clearcoatRoughness = 0.85;
      earthMaterial.needsUpdate = true;

      if (this.countryBorderLines) {
        this.tiltGroup.remove(this.countryBorderLines);
        this.countryBorderLines.geometry.dispose();
        (this.countryBorderLines.material as THREE.Material).dispose();
      }

      this.countryBorderLines = this.createCountryBorderLines(borders);
      this.tiltGroup.add(this.countryBorderLines);
    } catch {
      return;
    }
  }

  private reanchorMoment(referenceUtcMs: number, city: City): void {
    const localDate = cityLocalDate(referenceUtcMs, city);
    this.dayOfYear.set(dayOfYearFromDate(localDate));
    this.hourOfDay.set(localDate.getUTCHours() * 60 + localDate.getUTCMinutes());
  }

  private requiredFovForTargets(
    cameraPosition: THREE.Vector3,
    targetPoints: THREE.Vector3[],
    marginDegrees = 6
  ): number {
    const forward = cameraPosition.clone().multiplyScalar(-1).normalize();
    let maxAngle = 0;

    for (const point of targetPoints) {
      const ray = point.clone().sub(cameraPosition).normalize();
      maxAngle = Math.max(maxAngle, forward.angleTo(ray));
    }

    return clamp(THREE.MathUtils.radToDeg(maxAngle) * 2 + marginDegrees, 34, 48);
  }

  private planCameraForActiveCity(animate: boolean): void {
    if (!this.camera) {
      return;
    }

    const activeCity = this.activeCity();
    const subsolar = this.subsolarPoint();
    const nextFocusX = THREE.MathUtils.degToRad(clamp(activeCity.lat, -72, 72));
    const nextFocusY = -THREE.MathUtils.degToRad(activeCity.lng);
    const cityDirection = directionForLatLngWithFocus(activeCity.lat, activeCity.lng, nextFocusX, nextFocusY);
    const sunDirection = directionForLatLngWithFocus(subsolar.lat, subsolar.lng, nextFocusX, nextFocusY);
    const framingDirection = cityDirection.clone().multiplyScalar(1.42).add(sunDirection.clone().multiplyScalar(1.12));

    if (framingDirection.lengthSq() < 0.0001) {
      framingDirection.copy(cityDirection);
    }

    framingDirection.normalize();

    if (framingDirection.dot(cityDirection) < 0.72) {
      framingDirection.lerp(cityDirection, 0.42).normalize();
    }

    const angularSeparation = Math.acos(clamp(cityDirection.dot(sunDirection), -1, 1));
    const distance = clamp(5.45 + angularSeparation * 1.28, 5.75, 7.8);
    const verticalBias = new THREE.Vector3(0, 0.16, 0);
    const desiredPosition = framingDirection.clone().multiplyScalar(distance).add(verticalBias);
    const desiredFov = this.requiredFovForTargets(desiredPosition, [
      cityDirection.clone().multiplyScalar(1.28),
      sunDirection.clone().multiplyScalar(5)
    ]);

    this.targetFocusX = nextFocusX;
    this.targetFocusY = nextFocusY;
    this.desiredCameraPosition.copy(desiredPosition);
    this.camera.fov = desiredFov;
    this.camera.updateProjectionMatrix();

    if (!animate) {
      this.currentFocusX = nextFocusX;
      this.currentFocusY = nextFocusY;
      this.focusGroup?.rotation.set(nextFocusX, nextFocusY, 0);
      this.camera.position.copy(this.desiredCameraPosition);
      this.controls?.update();
      this.autoFramingActive = false;
      return;
    }

    this.autoFramingActive = true;
  }

  private initScene(host: HTMLDivElement): void {
    try {
      const width = host.clientWidth || 960;
      const height = host.clientHeight || 720;

      this.scene = new THREE.Scene();
      this.scene.fog = new THREE.FogExp2('#04111f', 0.028);

      this.camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 120);
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
      this.controls.minDistance = 2.1;
      this.controls.maxDistance = 9.2;
      this.controls.target.set(0, 0, 0);
      this.controls.addEventListener('start', () => {
        this.autoFramingActive = false;
      });

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
      this.planCameraForActiveCity(false);
      void this.loadGeographyData();
      void this.ensureWorldCatalogLoaded();
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
        opacity: 0.08,
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

    this.tiltGroup.add(this.earthSphere, this.atmosphereSphere);
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

    this.sunLight = new THREE.DirectionalLight('#ffd889', 3.8);
    this.sunLight.position.set(4.6, 1.4, 4.4);
    this.scene.add(this.sunLight);
    this.sunPointLight = new THREE.PointLight('#ffcf78', 10, 26, 1.6);
    this.sunPointLight.position.set(4.6, 1.4, 4.4);
    this.scene.add(this.sunPointLight);

    this.sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.23, 32, 32),
      new THREE.MeshBasicMaterial({ color: '#ffd97a' })
    );
    this.sunHalo = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 32, 32),
      new THREE.MeshBasicMaterial({
        color: '#ffd37a',
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending
      })
    );
    this.sunCorona = new THREE.Mesh(
      new THREE.SphereGeometry(0.72, 32, 32),
      new THREE.MeshBasicMaterial({
        color: '#ffbc63',
        transparent: true,
        opacity: 0.12,
        blending: THREE.AdditiveBlending
      })
    );

    this.scene.add(this.sunMesh, this.sunHalo, this.sunCorona);
  }

  private createMarkers(): void {
    this.syncMarkers(this.citySnapshots(), this.activeCity().id);
  }

  private syncMarkers(snapshots: CitySnapshot[], activeCityId: string): void {
    if (!this.markerRoot) {
      return;
    }

    const expectedIds = new Set([activeCityId]);

    this.markerBundles.forEach((bundle, cityId) => {
      if (expectedIds.has(cityId)) {
        return;
      }

      this.markerRoot?.remove(bundle.group);
      this.disposeMarker(bundle);
      this.markerBundles.delete(cityId);
    });

    snapshots.forEach((snapshot) => {
      if (snapshot.city.id !== activeCityId) {
        return;
      }

      let bundle = this.markerBundles.get(snapshot.city.id);

      if (!bundle) {
        bundle = this.createMarker(snapshot.city);
        this.markerBundles.set(snapshot.city.id, bundle);
        this.markerRoot?.add(bundle.group);
      }

      const color =
        snapshot.phase === 'day' ? '#ffbf54' : snapshot.phase === 'twilight' ? '#ff8b43' : '#64b5ff';
      const material = bundle.dot.material as THREE.MeshStandardMaterial;
      material.color.set(color);
      material.emissive.set(color);
      material.emissiveIntensity = 1.1;
      bundle.group.scale.setScalar(1);
    });
  }

  private createMarker(city: City): MarkerBundle {
    const group = new THREE.Group();
    const outward = latLngToVector(city.lat, city.lng, 1.28);
    group.position.copy(outward);
    group.lookAt(outward.clone().multiplyScalar(2));

    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.048, 22, 22),
      new THREE.MeshStandardMaterial({
        color: '#ffbf54',
        emissive: '#ffbf54',
        emissiveIntensity: 1.35,
        roughness: 0.18
      })
    );
    dot.position.z = 0.06;

    group.add(dot);
    return { group, dot };
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

  private createDetailedEarthTexture(features: GeoFeature[]): EarthTextureSet {
    const width = 4096;
    const height = 2048;
    const colorCanvas = document.createElement('canvas');
    const bumpCanvas = document.createElement('canvas');
    const roughnessCanvas = document.createElement('canvas');
    colorCanvas.width = bumpCanvas.width = roughnessCanvas.width = width;
    colorCanvas.height = bumpCanvas.height = roughnessCanvas.height = height;

    const colorCtx = colorCanvas.getContext('2d')!;
    const bumpCtx = bumpCanvas.getContext('2d')!;
    const roughnessCtx = roughnessCanvas.getContext('2d')!;

    const oceanGradient = colorCtx.createLinearGradient(0, 0, 0, height);
    oceanGradient.addColorStop(0, '#29567f');
    oceanGradient.addColorStop(0.18, '#1f466d');
    oceanGradient.addColorStop(0.46, '#123356');
    oceanGradient.addColorStop(1, '#09182d');
    colorCtx.fillStyle = oceanGradient;
    colorCtx.fillRect(0, 0, width, height);

    bumpCtx.fillStyle = 'rgb(26 26 26)';
    bumpCtx.fillRect(0, 0, width, height);

    roughnessCtx.fillStyle = 'rgb(16 16 16)';
    roughnessCtx.fillRect(0, 0, width, height);

    for (let latitude = 0; latitude <= 24; latitude += 1) {
      const y = (latitude / 24) * height;
      colorCtx.strokeStyle =
        latitude % 6 === 0 ? 'rgba(186, 216, 241, 0.045)' : 'rgba(186, 216, 241, 0.02)';
      colorCtx.lineWidth = latitude % 6 === 0 ? 1.4 : 0.8;
      colorCtx.beginPath();
      colorCtx.moveTo(0, y);
      colorCtx.lineTo(width, y);
      colorCtx.stroke();
    }

    for (let longitude = 0; longitude <= 48; longitude += 1) {
      const x = (longitude / 48) * width;
      colorCtx.strokeStyle =
        longitude % 6 === 0 ? 'rgba(186, 216, 241, 0.032)' : 'rgba(186, 216, 241, 0.014)';
      colorCtx.lineWidth = longitude % 6 === 0 ? 1.1 : 0.7;
      colorCtx.beginPath();
      colorCtx.moveTo(x, 0);
      colorCtx.lineTo(x, height);
      colorCtx.stroke();
    }

    for (let sweep = 0; sweep < 18; sweep += 1) {
      const y = pseudoRandomPositive(sweep * 1.4) * height;
      const ellipseHeight = 60 + pseudoRandomPositive(sweep * 2.2) * 120;
      const gradient = colorCtx.createLinearGradient(0, y - ellipseHeight, 0, y + ellipseHeight);
      gradient.addColorStop(0, 'rgba(114, 173, 217, 0)');
      gradient.addColorStop(
        0.5,
        `rgba(114, 173, 217, ${0.018 + pseudoRandomPositive(sweep) * 0.02})`
      );
      gradient.addColorStop(1, 'rgba(114, 173, 217, 0)');
      colorCtx.fillStyle = gradient;
      colorCtx.fillRect(0, y - ellipseHeight, width, ellipseHeight * 2);
    }

    for (const feature of features) {
      const name = feature.properties?.name ?? 'earth';
      const hash = hashString(name);
      const point = this.computeCountryLabelPoint(feature);
      const absLat = Math.abs(point?.lat ?? 0);
      const dryFactor = pseudoRandomPositive(hash * 0.031);
      const lushFactor = pseudoRandomPositive(hash * 0.019);

      let baseHue = 115;
      let baseSaturation = 30;
      let baseLightness = 28;

      if (absLat > 70) {
        baseHue = 156;
        baseSaturation = 14;
        baseLightness = 72;
      } else if (absLat > 55) {
        baseHue = 98;
        baseSaturation = 22;
        baseLightness = 34;
      } else if (absLat < 16 && dryFactor > 0.62) {
        baseHue = 42;
        baseSaturation = 38;
        baseLightness = 40;
      } else if (absLat < 18) {
        baseHue = 122;
        baseSaturation = 36;
        baseLightness = 28;
      } else if (absLat < 32) {
        baseHue = 92;
        baseSaturation = 30;
        baseLightness = 31;
      }

      colorCtx.fillStyle = `hsl(${baseHue + (hash % 7) - 3} ${baseSaturation + lushFactor * 10}% ${baseLightness + lushFactor * 6}%)`;
      colorCtx.strokeStyle = 'rgba(218, 240, 221, 0.16)';
      colorCtx.lineWidth = 0.55;
      bumpCtx.fillStyle = `rgb(${82 + lushFactor * 34} ${82 + lushFactor * 34} ${82 + lushFactor * 34})`;
      roughnessCtx.fillStyle = `rgb(${148 + dryFactor * 48} ${148 + dryFactor * 48} ${148 + dryFactor * 48})`;

      this.forEachFeaturePolygon(feature, (rings) => {
        this.drawPolygonOnContext(colorCtx, rings, width, height, true, true);
        this.drawPolygonOnContext(bumpCtx, rings, width, height, true, false);
        this.drawPolygonOnContext(roughnessCtx, rings, width, height, true, false);

        colorCtx.save();
        bumpCtx.save();
        roughnessCtx.save();
        this.clipPolygonOnContext(colorCtx, rings, width, height);
        this.clipPolygonOnContext(bumpCtx, rings, width, height);
        this.clipPolygonOnContext(roughnessCtx, rings, width, height);

        const detailCount = 7 + (hash % 6);
        for (let index = 0; index < detailCount; index += 1) {
          const seed = hash * (index + 1);
          const center = point ?? { lat: 0, lng: 0 };
          const x = ((normalizeLongitude(center.lng + (pseudoRandomPositive(seed) - 0.5) * 18) + 180) / 360) * width;
          const y = ((90 - (center.lat + (pseudoRandomPositive(seed * 2.1) - 0.5) * 12)) / 180) * height;
          const radiusX = 28 + pseudoRandomPositive(seed * 3.7) * 120;
          const radiusY = 10 + pseudoRandomPositive(seed * 4.4) * 52;
          const rotation = pseudoRandomPositive(seed * 5.1) * TAU;
          const toneShift = pseudoRandomPositive(seed * 6.1);

          colorCtx.save();
          colorCtx.translate(x, y);
          colorCtx.rotate(rotation);
          colorCtx.fillStyle =
            absLat > 68
              ? `rgba(198, 213, 221, ${0.03 + toneShift * 0.04})`
              : dryFactor > 0.65 && absLat < 28
                ? `rgba(211, 178, 110, ${0.08 + toneShift * 0.08})`
                : `rgba(76, 114, 65, ${0.06 + toneShift * 0.07})`;
          colorCtx.beginPath();
          colorCtx.ellipse(0, 0, radiusX, radiusY, 0, 0, TAU);
          colorCtx.fill();
          colorCtx.restore();

          bumpCtx.save();
          bumpCtx.translate(x, y);
          bumpCtx.rotate(rotation);
          const relief = Math.floor(126 + toneShift * 80);
          bumpCtx.fillStyle = `rgb(${relief} ${relief} ${relief})`;
          bumpCtx.beginPath();
          bumpCtx.ellipse(0, 0, radiusX * 0.9, radiusY * 0.8, 0, 0, TAU);
          bumpCtx.fill();
          bumpCtx.restore();

          roughnessCtx.save();
          roughnessCtx.translate(x, y);
          roughnessCtx.rotate(rotation);
          const rough = Math.floor(118 + toneShift * 90);
          roughnessCtx.fillStyle = `rgb(${rough} ${rough} ${rough})`;
          roughnessCtx.beginPath();
          roughnessCtx.ellipse(0, 0, radiusX * 0.94, radiusY * 0.82, 0, 0, TAU);
          roughnessCtx.fill();
          roughnessCtx.restore();
        }

        colorCtx.restore();
        bumpCtx.restore();
        roughnessCtx.restore();
      });
    }

    const vignette = colorCtx.createRadialGradient(
      width * 0.5,
      height * 0.5,
      width * 0.18,
      width * 0.5,
      height * 0.5,
      width * 0.64
    );
    vignette.addColorStop(0, 'rgba(255,255,255,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.24)');
    colorCtx.fillStyle = vignette;
    colorCtx.fillRect(0, 0, width, height);

    return {
      color: this.canvasToTexture(colorCanvas),
      bump: this.canvasToTexture(bumpCanvas),
      roughness: this.canvasToTexture(roughnessCanvas)
    };
  }

  private forEachFeaturePolygon(feature: GeoFeature, callback: (rings: GeoPosition[][]) => void): void {
    if (feature.geometry.type === 'Polygon') {
      callback(feature.geometry.coordinates as GeoPosition[][]);
      return;
    }

    for (const polygon of feature.geometry.coordinates as GeoPosition[][][]) {
      callback(polygon);
    }
  }

  private tracePolygonPath(
    ctx: CanvasRenderingContext2D,
    rings: GeoPosition[][],
    width: number,
    height: number
  ): void {
    ctx.beginPath();

    for (const ring of rings) {
      if (!ring.length) {
        continue;
      }

      let first = true;
      let previousX = 0;

      for (const [lng, lat] of ring) {
        const x = ((lng + 180) / 360) * width;
        const y = ((90 - lat) / 180) * height;

        if (first || Math.abs(x - previousX) > width * 0.5) {
          ctx.moveTo(x, y);
          first = false;
        } else {
          ctx.lineTo(x, y);
        }

        previousX = x;
      }

      ctx.closePath();
    }
  }

  private drawPolygonOnContext(
    ctx: CanvasRenderingContext2D,
    rings: GeoPosition[][],
    width: number,
    height: number,
    fill: boolean,
    stroke: boolean
  ): void {
    this.tracePolygonPath(ctx, rings, width, height);

    if (fill) {
      ctx.fill();
    }

    if (stroke) {
      ctx.stroke();
    }
  }

  private clipPolygonOnContext(
    ctx: CanvasRenderingContext2D,
    rings: GeoPosition[][],
    width: number,
    height: number
  ): void {
    this.tracePolygonPath(ctx, rings, width, height);
    ctx.clip();
  }

  private canvasToTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    // Three.js sphere UVs place Greenwich 90 degrees away from our globe math, so align all generated
    // Earth textures to the same longitude system used by markers, borders, and sun targeting.
    texture.offset.x = 0.25;
    texture.anisotropy = this.renderer?.capabilities.getMaxAnisotropy?.() ?? 1;
    texture.needsUpdate = true;
    return texture;
  }

  private computeCountryLabelPoint(feature: GeoFeature): CountryLabelPoint | null {
    const points: GeoPosition[] = [];
    this.forEachFeaturePolygon(feature, (rings) => {
      const outerRing = rings[0];
      if (outerRing) {
        points.push(...outerRing);
      }
    });

    if (!points.length || !feature.properties?.name) {
      return null;
    }

    let minLat = 90;
    let maxLat = -90;
    let minLng = 180;
    let maxLng = -180;

    for (const [lng, lat] of points) {
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
    }

    return {
      name: feature.properties.name,
      lat: (minLat + maxLat) / 2,
      lng: normalizeLongitude((minLng + maxLng) / 2)
    };
  }

  private createCountryBorderLines(borders: GeoMultiLineString): THREE.LineSegments {
    const positions: number[] = [];

    for (const line of borders.coordinates) {
      for (let index = 0; index < line.length - 1; index += 1) {
        const [lngA, latA] = line[index];
        const [lngB, latB] = line[index + 1];
        const pointA = latLngToVector(latA, lngA, 1.209);
        const pointB = latLngToVector(latB, lngB, 1.209);
        positions.push(pointA.x, pointA.y, pointA.z, pointB.x, pointB.y, pointB.z);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

    const material = new THREE.LineBasicMaterial({
      color: '#2d658b',
      transparent: true,
      opacity: 0.08
    });

    return new THREE.LineSegments(geometry, material);
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

    return this.canvasToTexture(canvas);
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

    return this.canvasToTexture(canvas);
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

    return this.canvasToTexture(canvas);
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

  private updateActiveCityOverlay(): void {
    const overlay = this.activeCityOverlay?.nativeElement;

    if (!overlay) {
      return;
    }

    const host = this.sceneHost?.nativeElement;
    const camera = this.camera;
    const activeCityId = this.activeCity().id;
    const marker = this.markerBundles.get(activeCityId);

    if (!host || !camera || !marker) {
      overlay.style.opacity = '0';
      return;
    }

    marker.dot.getWorldPosition(this.tempVector);
    this.tempVectorB.copy(this.tempVector).project(camera);
    const projectedZ = this.tempVectorB.z;
    const width = host.clientWidth || 1;
    const height = host.clientHeight || 1;
    const x = (this.tempVectorB.x * 0.5 + 0.5) * width;
    const y = (-this.tempVectorB.y * 0.5 + 0.5) * height;
    const facing = this.tempVector.normalize().dot(this.tempVectorB.copy(camera.position).normalize());
    const visible =
      facing > 0.12 &&
      projectedZ > -1 &&
      projectedZ < 1 &&
      x > -40 &&
      x < width + 40 &&
      y > -40 &&
      y < height + 40;

    overlay.style.opacity = visible ? '1' : '0';
    overlay.style.transform = `translate3d(${Math.round(x + 18)}px, ${Math.round(y - 18)}px, 0)`;
  }

  private updateSunTarget(subsolarLat: number, subsolarLng: number): void {
    if (
      !this.tiltGroup ||
      !this.sunLight ||
      !this.sunMesh ||
      !this.sunHalo ||
      !this.sunCorona ||
      !this.sunPointLight
    ) {
      return;
    }

    this.tempVector.copy(latLngToVector(subsolarLat, subsolarLng, 5));
    this.tiltGroup.localToWorld(this.tempVector);
    this.sunLight.position.lerp(this.tempVector, 0.35);
    this.sunPointLight.position.lerp(this.tempVector, 0.35);
    this.sunMesh.position.lerp(this.tempVector, 0.35);
    this.sunHalo.position.lerp(this.tempVector, 0.35);
    this.sunCorona.position.lerp(this.tempVector, 0.35);
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

    if (this.autoFramingActive) {
      this.camera.position.lerp(this.desiredCameraPosition, 0.06);

      if (this.camera.position.distanceToSquared(this.desiredCameraPosition) < 0.0008) {
        this.camera.position.copy(this.desiredCameraPosition);
        this.autoFramingActive = false;
      }
    }

    if (this.cloudsSphere) {
      this.cloudsSphere.rotation.y += 0.00045;
    }

    if (this.atmosphereSphere) {
      this.atmosphereSphere.rotation.y -= 0.00018;
    }

    if (this.countryBorderLines) {
      const material = this.countryBorderLines.material as THREE.LineBasicMaterial;
      material.opacity = THREE.MathUtils.mapLinear(this.camera.position.length(), 7.4, 2.1, 0.03, 0.12);
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
      this.sunHalo.scale.setScalar(pulse * 1.18);
    }

    if (this.sunCorona) {
      this.sunCorona.scale.setScalar(1.35 + Math.sin(performance.now() * 0.0015) * 0.08);
    }

    if (this.sunPointLight) {
      this.sunPointLight.intensity = 10.5 + Math.sin(performance.now() * 0.0018) * 0.8;
    }

    this.markerBundles.forEach((bundle) => {
      const scale = 1 + Math.sin(performance.now() * 0.0032) * 0.08;
      bundle.dot.scale.setScalar(scale);
    });

    this.controls?.update();
    this.updateSunTarget(this.subsolarPoint().lat, this.subsolarPoint().lng);
    this.updateActiveCityOverlay();
    this.composer.render();
  };
}
