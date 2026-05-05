const state = {
  data: null,
  map: null,
  layers: {
    routes: null,
    stations: null,
    trains: null,
  },
  selectedRouteId: null,
  selectedStationIds: new Set(),
  searchResults: [],
  stationIndex: new Map(),
  activeTrainMarkers: new Map(),
  refreshTimer: null,
};

const selectors = {
  origin: document.querySelector("#origin"),
  destination: document.querySelector("#destination"),
  date: document.querySelector("#date"),
  searchForm: document.querySelector("#search-form"),
  resetButton: document.querySelector("#reset-button"),
  resultsList: document.querySelector("#results-list"),
  statusText: document.querySelector("#status-text"),
  updatedAt: document.querySelector("#updated-at"),
  routesCount: document.querySelector("#routes-count"),
  trainsCount: document.querySelector("#trains-count"),
  stationsCount: document.querySelector("#stations-count"),
  sourceBadge: document.querySelector("#source-badge"),
  routeDetails: document.querySelector("#route-details"),
  stationList: document.querySelector("#station-list"),
  refreshButton: document.querySelector("#refresh-button"),
};

const MINUTE = 60 * 1000;

document.addEventListener("DOMContentLoaded", initializeApp);

async function initializeApp() {
  setStatus("Загружаем маршруты РЖД...");
  initializeMap();
  bindEvents();

  try {
    const data = await fetchJson("/api/routes");
    hydrateDataset(data);
    renderStationOptions();
    renderStationList();
    renderStats();
    drawAllRoutes();
    drawStations();
    updateTrainPositions();
    renderResults(state.data.routes);
    selectRoute(state.data.routes[0]?.id);
    scheduleRealtimeUpdates();
    setStatus("Данные загружены. Маркеры поездов обновляются каждую минуту.");
  } catch (error) {
    console.error(error);
    setStatus("Не удалось загрузить маршруты. Проверьте сервер приложения.", true);
  }
}

function initializeMap() {
  state.map = L.map("map", {
    zoomControl: false,
    preferCanvas: true,
  }).setView([56.3, 60.7], 4);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(state.map);

  L.control.zoom({ position: "bottomright" }).addTo(state.map);

  state.layers.routes = L.layerGroup().addTo(state.map);
  state.layers.stations = L.layerGroup().addTo(state.map);
  state.layers.trains = L.layerGroup().addTo(state.map);
}

function bindEvents() {
  selectors.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    runSearch();
  });

  selectors.resetButton.addEventListener("click", () => {
    selectors.origin.value = "";
    selectors.destination.value = "";
    state.selectedStationIds.clear();
    state.selectedRouteId = null;
    renderResults(state.data.routes);
    drawAllRoutes();
    drawStations();
    updateTrainPositions();
    fitToAllRoutes();
    setStatus("Фильтры сброшены.");
  });

  selectors.refreshButton.addEventListener("click", () => {
    updateTrainPositions();
    renderStats();
    setStatus("Положение поездов обновлено.");
  });

  const today = new Date();
  selectors.date.value = today.toISOString().slice(0, 10);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while loading ${url}`);
  }
  return response.json();
}

function hydrateDataset(data) {
  state.data = normalizeRoutes(data);
  state.stationIndex = new Map(state.data.stations.map((station) => [station.id, station]));
}

function normalizeRoutes(data) {
  const stationIndex = new Map(data.stations.map((station) => [station.id, station]));
  const routes = data.routes.map((route) => {
    const stops = route.stops
      .map((stop) => ({
        ...stop,
        station: stationIndex.get(stop.stationId),
      }))
      .filter((stop) => stop.station)
      .sort((a, b) => a.offset - b.offset);

    return {
      ...route,
      stops,
      origin: stationIndex.get(route.originId),
      destination: stationIndex.get(route.destinationId),
      durationMinutes: stops.at(-1)?.offset ?? 0,
      polyline: stops.map((stop) => stop.station.coords),
    };
  });

  return { ...data, routes };
}

function renderStationOptions() {
  const sortedStations = [...state.data.stations].sort((a, b) =>
    a.name.localeCompare(b.name, "ru"),
  );

  for (const station of sortedStations) {
    const option = document.createElement("option");
    option.value = station.id;
    option.label = `${station.name} - ${station.stationName}`;
    option.textContent = `${station.name} - ${station.stationName}`;
    selectors.origin.append(option.cloneNode());
    selectors.destination.append(option);
  }
}

function renderStats() {
  selectors.routesCount.textContent = state.data.routes.length.toString();
  selectors.trainsCount.textContent = getActiveDepartures(state.data.routes).length.toString();
  selectors.stationsCount.textContent = state.data.stations.length.toString();
  selectors.updatedAt.textContent = `обновлено ${formatTime(new Date())}`;
  selectors.sourceBadge.textContent = state.data.source?.name ?? "RZD";
}

function drawAllRoutes(routes = state.searchResults.length ? state.searchResults : state.data.routes) {
  state.layers.routes.clearLayers();

  routes.forEach((route) => {
    const isSelected = route.id === state.selectedRouteId;
    const line = L.polyline(route.polyline, {
      color: route.color,
      weight: isSelected ? 7 : 4,
      opacity: isSelected ? 0.95 : 0.62,
      lineCap: "round",
      lineJoin: "round",
    });

    line.bindTooltip(`${route.trainNumber} ${route.brand}: ${route.title}`, {
      sticky: true,
      direction: "top",
    });
    line.on("click", () => selectRoute(route.id));
    line.addTo(state.layers.routes);
  });
}

function drawStations() {
  state.layers.stations.clearLayers();

  for (const station of state.data.stations) {
    const isSelected = state.selectedStationIds.has(station.id);
    const marker = L.circleMarker(station.coords, {
      radius: isSelected ? 8 : 5,
      fillColor: isSelected ? "#f97316" : "#ffffff",
      fillOpacity: 1,
      color: isSelected ? "#f97316" : "#0f172a",
      weight: isSelected ? 3 : 2,
    }).addTo(state.layers.stations);

    marker.bindPopup(`
      <strong>${escapeHtml(station.name)}</strong><br>
      ${escapeHtml(station.stationName)}<br>
      Код РЖД: ${escapeHtml(station.code)}
    `);
  }
}

function updateTrainPositions() {
  state.layers.trains.clearLayers();
  state.activeTrainMarkers.clear();

  const visibleRoutes = state.searchResults.length ? state.searchResults : state.data.routes;
  const activeDepartures = getActiveDepartures(visibleRoutes);

  activeDepartures.forEach((train) => {
    const position = interpolateTrainPosition(train.route, train.minutesSinceDeparture);
    if (!position) return;

    const icon = L.divIcon({
      className: "",
      html: `<div class="train-marker" style="--route-color:${train.route.color}"><span>${escapeHtml(train.route.trainNumber)}</span></div>`,
      iconSize: [46, 28],
      iconAnchor: [23, 14],
    });

    const marker = L.marker(position.coords, { icon }).addTo(state.layers.trains);
    marker.bindPopup(renderTrainPopup(train, position));
    state.activeTrainMarkers.set(`${train.route.id}-${train.departure}`, marker);
  });

  selectors.trainsCount.textContent = activeDepartures.length.toString();
  selectors.updatedAt.textContent = `обновлено ${formatTime(new Date())}`;
}

function getActiveDepartures(routes) {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const yesterdayOffset = 24 * 60;
  const active = [];

  for (const route of routes) {
    for (const departure of route.departures) {
      const departureMinutes = parseClock(departure);
      const candidates = [nowMinutes - departureMinutes, nowMinutes + yesterdayOffset - departureMinutes];
      const minutesSinceDeparture = candidates.find(
        (candidate) => candidate >= 0 && candidate <= route.durationMinutes,
      );

      if (minutesSinceDeparture !== undefined) {
        active.push({ route, departure, minutesSinceDeparture });
      }
    }
  }

  return active;
}

function interpolateTrainPosition(route, minutesSinceDeparture) {
  const stops = route.stops;
  if (stops.length < 2) return null;

  const nextStopIndex = stops.findIndex((stop) => stop.offset >= minutesSinceDeparture);
  if (nextStopIndex <= 0) {
    return {
      coords: stops[0].station.coords,
      nextStop: stops[1],
      previousStop: stops[0],
      progress: 0,
    };
  }

  const previousStop = stops[nextStopIndex - 1];
  const nextStop = stops[nextStopIndex];
  const legDuration = nextStop.offset - previousStop.offset || 1;
  const progress = (minutesSinceDeparture - previousStop.offset) / legDuration;

  const lat = previousStop.station.coords[0] + (nextStop.station.coords[0] - previousStop.station.coords[0]) * progress;
  const lng = previousStop.station.coords[1] + (nextStop.station.coords[1] - previousStop.station.coords[1]) * progress;

  return {
    coords: [lat, lng],
    previousStop,
    nextStop,
    progress,
  };
}

function runSearch() {
  const originId = selectors.origin.value;
  const destinationId = selectors.destination.value;

  state.selectedStationIds = new Set([originId, destinationId].filter(Boolean));
  const results = state.data.routes.filter((route) => routeMatches(route, originId, destinationId));
  state.searchResults = results;
  state.selectedRouteId = results[0]?.id ?? null;

  renderResults(results);
  drawAllRoutes(results);
  drawStations();
  updateTrainPositions();

  if (results.length) {
    fitRoutes(results);
    renderRouteDetails(results[0]);
    setStatus(`Найдено маршрутов: ${results.length}.`);
  } else {
    renderEmptyRouteDetails();
    setStatus("Маршруты между выбранными станциями не найдены в текущем наборе данных.", true);
  }

  requestLiveTimetable(originId, destinationId);
}

function routeMatches(route, originId, destinationId) {
  const stopIds = route.stops.map((stop) => stop.stationId);

  if (originId && destinationId) {
    const originIndex = stopIds.indexOf(originId);
    const destinationIndex = stopIds.indexOf(destinationId);
    return originIndex !== -1 && destinationIndex !== -1 && originIndex !== destinationIndex;
  }

  if (originId) return stopIds.includes(originId);
  if (destinationId) return stopIds.includes(destinationId);
  return true;
}

async function requestLiveTimetable(originId, destinationId) {
  if (!originId || !destinationId || originId === destinationId) return;

  const origin = state.stationIndex.get(originId);
  const destination = state.stationIndex.get(destinationId);
  if (!origin || !destination) return;

  const selectedDate = selectors.date.value || new Date().toISOString().slice(0, 10);
  const params = new URLSearchParams({
    origin: origin.code,
    destination: destination.code,
    date: formatRzdDate(selectedDate),
  });

  try {
    const live = await fetchJson(`/api/rzd/search?${params.toString()}`);
    if (live.status === "unavailable") {
      setStatus(
        "Поиск выполнен по встроенному набору маршрутов. Live-ответ РЖД недоступен или требует внешний proxy.",
      );
      return;
    }

    if (live.trains?.length) {
      appendLiveResults(live.trains);
      setStatus(`Получены live-данные РЖД: ${live.trains.length} поездов.`);
    }
  } catch (error) {
    console.warn("RZD live lookup failed", error);
  }
}

function appendLiveResults(trains) {
  const liveContainer = document.createElement("section");
  liveContainer.className = "live-results";
  liveContainer.innerHTML = `
    <h3>Ответ pass.rzd.ru</h3>
    <div class="live-grid">
      ${trains
        .slice(0, 6)
        .map(
          (train) => `
            <article>
              <strong>${escapeHtml(train.number ?? "Поезд")}</strong>
              <span>${escapeHtml(train.route ?? "Маршрут РЖД")}</span>
              <small>${escapeHtml(train.departure ?? "")} - ${escapeHtml(train.arrival ?? "")}</small>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
  selectors.resultsList.append(liveContainer);
}

function renderResults(routes) {
  selectors.resultsList.innerHTML = "";

  if (!routes.length) {
    selectors.resultsList.innerHTML = `
      <div class="empty-state">
        <strong>Ничего не найдено</strong>
        <span>Попробуйте выбрать другие станции или сбросить фильтр.</span>
      </div>
    `;
    return;
  }

  routes.forEach((route) => {
    const item = document.createElement("button");
    item.className = `route-card ${route.id === state.selectedRouteId ? "is-active" : ""}`;
    item.type = "button";
    item.style.setProperty("--route-color", route.color);
    item.innerHTML = `
      <span class="route-card__stripe" style="background:${route.color}"></span>
      <span>
        <strong>${escapeHtml(route.trainNumber)} ${escapeHtml(route.brand)}</strong>
        <small>${escapeHtml(route.title)}</small>
      </span>
      <span>
        <strong>${formatDuration(route.durationMinutes)}</strong>
        <small>${route.distanceKm.toLocaleString("ru-RU")} км</small>
      </span>
    `;
    item.addEventListener("click", () => selectRoute(route.id));
    selectors.resultsList.append(item);
  });
}

function selectRoute(routeId) {
  if (!routeId) {
    renderEmptyRouteDetails();
    return;
  }

  const route = state.data.routes.find((candidate) => candidate.id === routeId);
  if (!route) return;

  state.selectedRouteId = route.id;
  state.searchResults = state.searchResults.length ? state.searchResults : [];
  renderResults(state.searchResults.length ? state.searchResults : state.data.routes);
  drawAllRoutes(state.searchResults.length ? state.searchResults : state.data.routes);
  renderRouteDetails(route);
  fitRoutes([route]);
}

function renderRouteDetails(route) {
  const activeTrain = getActiveDepartures([route])[0];
  selectors.routeDetails.innerHTML = `
    <div class="route-summary">
      <span class="route-dot" style="background:${route.color}"></span>
      <div>
        <h3>${escapeHtml(route.trainNumber)} ${escapeHtml(route.brand)}</h3>
        <p>${escapeHtml(route.title)} · ${escapeHtml(route.operator)}</p>
      </div>
    </div>
    <dl class="details-grid">
      <div><dt>В пути</dt><dd>${formatDuration(route.durationMinutes)}</dd></div>
      <div><dt>Длина</dt><dd>${route.distanceKm.toLocaleString("ru-RU")} км</dd></div>
      <div><dt>Отправления</dt><dd>${route.departures.join(", ")}</dd></div>
      <div><dt>Статус</dt><dd>${activeTrain ? "В движении" : "Ожидает рейса"}</dd></div>
    </dl>
    <ol class="timeline">
      ${route.stops
        .map(
          (stop) => `
            <li>
              <span>${formatOffset(stop.offset)}</span>
              <strong>${escapeHtml(stop.station.name)}</strong>
              <small>${escapeHtml(stop.station.stationName)}${stop.dwell ? ` · стоянка ${stop.dwell} мин` : ""}</small>
            </li>
          `,
        )
        .join("")}
    </ol>
  `;
}

function renderEmptyRouteDetails() {
  selectors.routeDetails.innerHTML = `
    <div class="empty-state">
      <strong>Выберите маршрут</strong>
      <span>Кликните по линии на карте или карточке рейса.</span>
    </div>
  `;
}

function renderStationList() {
  selectors.stationList.innerHTML = state.data.stations
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "ru"))
    .map(
      (station) => `
        <li>
          <strong>${escapeHtml(station.name)}</strong>
          <span>${escapeHtml(station.stationName)}</span>
          <small>${escapeHtml(station.code)}</small>
        </li>
      `,
    )
    .join("");
}

function renderTrainPopup(train, position) {
  const remaining = Math.max(0, train.route.durationMinutes - train.minutesSinceDeparture);
  return `
    <strong>${escapeHtml(train.route.trainNumber)} ${escapeHtml(train.route.brand)}</strong><br>
    ${escapeHtml(train.route.title)}<br>
    Отправление: ${escapeHtml(train.departure)}<br>
    Следующая станция: ${escapeHtml(position.nextStop.station.name)}<br>
    Осталось: ${formatDuration(remaining)}
  `;
}

function fitRoutes(routes) {
  const points = routes.flatMap((route) => route.polyline);
  if (!points.length) return;
  state.map.fitBounds(L.latLngBounds(points), { padding: [42, 42] });
}

function fitToAllRoutes() {
  fitRoutes(state.data.routes);
}

function scheduleRealtimeUpdates() {
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(updateTrainPositions, MINUTE);
}

function setStatus(message, isWarning = false) {
  selectors.statusText.textContent = message;
  selectors.statusText.classList.toggle("is-warning", isWarning);
}

function parseClock(clock) {
  const [hours, minutes] = clock.split(":").map(Number);
  return hours * 60 + minutes;
}

function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (!hours) return `${mins} мин`;
  return `${hours} ч ${mins.toString().padStart(2, "0")} мин`;
}

function formatOffset(minutes) {
  if (minutes === 0) return "старт";
  return `+${formatDuration(minutes)}`;
}

function formatTime(date) {
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function formatRzdDate(dateValue) {
  if (typeof dateValue === "string") {
    const [year, month, day] = dateValue.split("-");
    if (year && month && day) return `${day}.${month}.${year}`;
  }

  return dateValue.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
