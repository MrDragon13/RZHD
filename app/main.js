/*
 * Главный файл клиентской логики RZD Live Tracker.
 *
 * Здесь нет React/Vue/Svelte намеренно: приложение должно запускаться сразу из
 * статических файлов, без сборки и без установки зависимостей. Поэтому весь
 * интерфейс строится через обычный DOM API, а карта управляется через Leaflet.
 *
 * Комментарии ниже сделаны избыточно подробными по требованию задачи. Они
 * объясняют не только назначение функций, но и то, почему данные хранятся именно
 * так, как работает расчет положения поезда и где проходит граница между
 * встроенным каталогом маршрутов и live-ответом РЖД.
 */

// Единый объект состояния приложения. Такой подход проще отдельного state manager:
// данных немного, все они живут на одной странице, а изменения всегда проходят
// через функции рендера ниже.
const state = {
  // Нормализованный каталог маршрутов и станций, загруженный с `/api/routes`.
  data: null,
  // Экземпляр Leaflet-карты. Он создается один раз при старте приложения.
  map: null,
  // Отдельные группы слоев помогают быстро очищать/перерисовывать только линии,
  // только станции или только маркеры поездов, не пересоздавая карту целиком.
  layers: {
    routes: null,
    stations: null,
    trains: null,
  },
  // ID выбранного маршрута нужен, чтобы подсветить линию на карте и карточку в списке.
  selectedRouteId: null,
  // Множество выбранных станций используется для подсветки маркеров отправления и прибытия.
  selectedStationIds: new Set(),
  // Текущие результаты поиска. Пустой массив означает, что фильтр не применен и
  // надо показывать весь каталог.
  searchResults: [],
  // Быстрый индекс stationId -> station. Он избавляет от повторных проходов по
  // массиву станций при поиске маршрутов и формировании live-запросов.
  stationIndex: new Map(),
  // Храним созданные маркеры поездов для возможной будущей адресной работы с ними.
  activeTrainMarkers: new Map(),
  // ID interval-таймера, который каждую минуту пересчитывает положение поездов.
  refreshTimer: null,
};

// Все обращения к DOM собраны в одном месте. Это облегчает проверку, что id в
// HTML и id в JavaScript совпадают, и не заставляет искать querySelector по всему файлу.
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

// Минутный интервал обновления выбран потому, что расписание и расчетное положение
// поездов в интерфейсе отображаются с точностью до минут, а более частое обновление
// создавало бы лишнюю работу без заметной пользы для пользователя.
const MINUTE = 60 * 1000;

// Ждем полной загрузки DOM, чтобы все элементы из index.html уже существовали.
document.addEventListener("DOMContentLoaded", initializeApp);

async function initializeApp() {
  // Стартовая последовательность важна: карту можно создать сразу, а вот маршруты,
  // станции и карточки рендерятся только после получения JSON-каталога с сервера.
  setStatus("Загружаем маршруты РЖД...");
  initializeMap();
  bindEvents();

  try {
    // Загружаем встроенный каталог через API, а не напрямую из JSON-файла. Так
    // фронтенд не зависит от внутренней структуры папок и может одинаково работать
    // локально, за reverse proxy или в контейнере.
    const data = await fetchJson("/api/routes");
    hydrateDataset(data);
    // После нормализации данных последовательно заполняем все части интерфейса:
    // селекты поиска, справочник станций, счетчики, карту и список маршрутов.
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
    // Ошибка загрузки каталога критична: без него нельзя нарисовать карту и поиск.
    // Сообщение показывается пользователю, а объект ошибки остается в консоли для
    // разработчика.
    console.error(error);
    setStatus("Не удалось загрузить маршруты. Проверьте сервер приложения.", true);
  }
}

function initializeMap() {
  // Leaflet получает контейнер #map из HTML. zoomControl отключаем на старте,
  // чтобы затем поставить контрол в нижний правый угол и не конфликтовать с сайдбаром.
  state.map = L.map("map", {
    zoomControl: false,
    preferCanvas: true,
  }).setView([56.3, 60.7], 4);

  // OpenStreetMap tiles используются как базовая подложка. Линии маршрутов и
  // маркеры поездов рисуются поверх нее отдельными Leaflet-слоями.
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(state.map);

  L.control.zoom({ position: "bottomright" }).addTo(state.map);

  // Три независимых layerGroup дают простую модель перерисовки:
  // - routes: полилинии железнодорожных маршрутов;
  // - stations: круги станций;
  // - trains: расчетные текущие положения поездов.
  state.layers.routes = L.layerGroup().addTo(state.map);
  state.layers.stations = L.layerGroup().addTo(state.map);
  state.layers.trains = L.layerGroup().addTo(state.map);

  // Leaflet рассчитывает положение тайлов, SVG-слоев и маршрутов от фактического
  // размера контейнера карты. Если браузер еще пересчитывает CSS-grid/оверлеи или
  // внешний CSS Leaflet загрузился с задержкой, первичный размер может быть
  // устаревшим. Два отложенных invalidateSize закрывают этот сценарий и убирают
  // эффект "перепутанных" тайлов и линий, нарисованных не в том масштабе.
  refreshMapSize();
  window.addEventListener("resize", refreshMapSize);
}

function bindEvents() {
  // Форма поиска не должна перезагружать страницу. Вместо этого мы фильтруем уже
  // загруженный каталог и дополнительно пытаемся запросить live-данные через сервер.
  selectors.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    runSearch();
  });

  // Сброс возвращает приложение в обзорный режим: все маршруты видимы, станции не
  // подсвечены, карта подгоняется под весь каталог.
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

  // Кнопка "Обновить" не ходит в сеть: расчетные позиции зависят от текущего
  // времени, поэтому достаточно пересчитать координаты поездов и счетчики.
  selectors.refreshButton.addEventListener("click", () => {
    updateTrainPositions();
    renderStats();
    setStatus("Положение поездов обновлено.");
  });

  // Поле даты заполняется текущим днем, чтобы пользователь мог сразу искать поезд
  // без ручного выбора даты.
  const today = new Date();
  selectors.date.value = today.toISOString().slice(0, 10);
}

async function fetchJson(url) {
  // Маленькая обертка над fetch делает обработку HTTP-ошибок явной. Иначе fetch
  // считает 404/500 успешным сетевым ответом, и ошибка проявилась бы позже при
  // попытке разобрать неожиданный HTML как JSON.
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while loading ${url}`);
  }
  return response.json();
}

function hydrateDataset(data) {
  // Нормализация превращает "сырой" JSON в структуру, удобную для карты: к каждой
  // остановке добавляется объект станции, а у маршрута появляется polyline.
  state.data = normalizeRoutes(data);
  state.stationIndex = new Map(state.data.stations.map((station) => [station.id, station]));
}

function normalizeRoutes(data) {
  // Индекс станций нужен на этапе нормализации, чтобы быстро связать stop.stationId
  // с полным объектом станции и ее координатами.
  const stationIndex = new Map(data.stations.map((station) => [station.id, station]));
  const routes = data.routes.map((route) => {
    // Остановки сортируются по offset, потому что именно этот порядок определяет
    // геометрию линии и расчет прогресса поезда между станциями.
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
      // origin/destination сохраняем рядом с маршрутом для удобного отображения в UI.
      origin: stationIndex.get(route.originId),
      destination: stationIndex.get(route.destinationId),
      // Длительность маршрута равна offset последней остановки от момента отправления.
      durationMinutes: stops.at(-1)?.offset ?? 0,
      // Leaflet polyline ожидает массив координат [lat, lng].
      polyline: stops.map((stop) => stop.station.coords),
    };
  });

  return { ...data, routes };
}

function renderStationOptions() {
  // Станции сортируются по русской локали, чтобы пользователь видел список в
  // привычном алфавитном порядке.
  const sortedStations = [...state.data.stations].sort((a, b) =>
    a.name.localeCompare(b.name, "ru"),
  );

  for (const station of sortedStations) {
    // value хранит внутренний id станции, а человекочитаемый текст показывает и
    // город, и конкретное название вокзала/станции.
    const option = document.createElement("option");
    option.value = station.id;
    option.label = `${station.name} - ${station.stationName}`;
    option.textContent = `${station.name} - ${station.stationName}`;
    selectors.origin.append(option.cloneNode());
    selectors.destination.append(option);
  }
}

function renderStats() {
  // Верхние счетчики в hero-блоке всегда отражают весь каталог, кроме числа поездов
  // "в пути", которое пересчитывается от текущего времени.
  selectors.routesCount.textContent = state.data.routes.length.toString();
  selectors.trainsCount.textContent = getActiveDepartures(state.data.routes).length.toString();
  selectors.stationsCount.textContent = state.data.stations.length.toString();
  selectors.updatedAt.textContent = `обновлено ${formatTime(new Date())}`;
  selectors.sourceBadge.textContent = state.data.source?.name ?? "RZD";
}

function drawAllRoutes(routes = state.searchResults.length ? state.searchResults : state.data.routes) {
  // Перед каждой перерисовкой очищаем слой маршрутов, чтобы не оставлять старые
  // линии после поиска или выбора другого фильтра.
  state.layers.routes.clearLayers();

  routes.forEach((route) => {
    // Выбранный маршрут рисуется толще и непрозрачнее. Это визуально связывает
    // карточку маршрута, детали и линию на карте.
    const isSelected = route.id === state.selectedRouteId;
    const line = L.polyline(route.polyline, {
      color: route.color,
      weight: isSelected ? 7 : 4,
      opacity: isSelected ? 0.95 : 0.62,
      lineCap: "round",
      lineJoin: "round",
    });

    // Tooltip появляется при наведении на линию и помогает понять, какой поезд
    // проходит по выбранному коридору без обязательного клика.
    line.bindTooltip(`${route.trainNumber} ${route.brand}: ${route.title}`, {
      sticky: true,
      direction: "top",
    });
    line.on("click", () => selectRoute(route.id));
    line.addTo(state.layers.routes);
  });
}

function drawStations() {
  // Станции рисуются отдельно от линий, чтобы их можно было подсвечивать независимо
  // от того, какие маршруты сейчас отфильтрованы.
  state.layers.stations.clearLayers();

  for (const station of state.data.stations) {
    // Если станция выбрана в форме поиска, увеличиваем радиус и меняем цвет, чтобы
    // пользователь сразу видел точки отправления/прибытия на карте.
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
  // Позиции поездов полностью расчетные: по расписанию отправления, длительности
  // маршрута и текущему времени. Поэтому при каждом обновлении проще очистить слой
  // и создать маркеры заново.
  state.layers.trains.clearLayers();
  state.activeTrainMarkers.clear();

  // Если применен поиск, маркеры показываем только для найденных маршрутов. В
  // обзорном режиме считаем активные отправления по всему каталогу.
  const visibleRoutes = state.searchResults.length ? state.searchResults : state.data.routes;
  const activeDepartures = getActiveDepartures(visibleRoutes);

  activeDepartures.forEach((train) => {
    // Координата вычисляется интерполяцией между двумя ближайшими остановками.
    const position = interpolateTrainPosition(train.route, train.minutesSinceDeparture);
    if (!position) return;

    // DivIcon позволяет сделать HTML-маркер с номером поезда и цветом маршрута.
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
  // Переводим текущее время в минуты от полуночи. Все отправления в seed-каталоге
  // также хранятся в формате HH:MM, поэтому сравнение становится простым.
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const yesterdayOffset = 24 * 60;
  const active = [];

  for (const route of routes) {
    for (const departure of route.departures) {
      const departureMinutes = parseClock(departure);
      // Проверяем два сценария:
      // 1. поезд отправился сегодня;
      // 2. поезд отправился вчера и все еще в пути после полуночи.
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
  // Без минимум двух остановок невозможно построить отрезок движения, поэтому
  // такой маршрут безопасно пропускаем.
  const stops = route.stops;
  if (stops.length < 2) return null;

  // Ищем первую остановку, offset которой больше или равен времени с отправления.
  // Она считается следующей станцией, а предыдущий элемент массива - предыдущей.
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

  // Линейная интерполяция по широте/долготе не повторяет точную железнодорожную
  // геометрию, но дает понятное расчетное положение поезда между станциями на
  // карте и не требует внешнего трекингового API.
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
  // Берем внутренние id станций из select. Пустая строка означает "любая станция".
  const originId = selectors.origin.value;
  const destinationId = selectors.destination.value;

  // Храним выбранные станции отдельно, чтобы функция drawStations могла подсветить
  // их даже тогда, когда по маршрутам ничего не найдено.
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

  // Live-запрос запускается после локального поиска. Даже если внешняя сеть
  // недоступна, пользователь уже видит результат по встроенному каталогу.
  requestLiveTimetable(originId, destinationId);
}

function routeMatches(route, originId, destinationId) {
  // У маршрута сравниваем не только origin/destination, а все остановки. Поэтому
  // поиск "Москва -> Тверь" найдет поезд Москва - Санкт-Петербург.
  const stopIds = route.stops.map((stop) => stop.stationId);

  if (originId && destinationId) {
    // Для пользовательского запроса "между станциями" допускаем оба направления
    // внутри одного маршрута. Это делает каталог удобнее, даже если seed-данные
    // содержат направление только туда.
    const originIndex = stopIds.indexOf(originId);
    const destinationIndex = stopIds.indexOf(destinationId);
    return originIndex !== -1 && destinationIndex !== -1 && originIndex !== destinationIndex;
  }

  if (originId) return stopIds.includes(originId);
  if (destinationId) return stopIds.includes(destinationId);
  return true;
}

async function requestLiveTimetable(originId, destinationId) {
  // Live-поиск имеет смысл только при выборе двух разных станций. Если пользователь
  // фильтрует по одной станции, встроенного каталога достаточно.
  if (!originId || !destinationId || originId === destinationId) return;

  // Серверный proxy ожидает station code РЖД, а не внутренний id приложения.
  const origin = state.stationIndex.get(originId);
  const destination = state.stationIndex.get(destinationId);
  if (!origin || !destination) return;

  // HTML date input возвращает `yyyy-mm-dd`. Для pass.rzd.ru нужен формат
  // `dd.mm.yyyy`, поэтому преобразование вынесено в отдельную функцию.
  const selectedDate = selectors.date.value || new Date().toISOString().slice(0, 10);
  const params = new URLSearchParams({
    origin: origin.code,
    destination: destination.code,
    date: formatRzdDate(selectedDate),
  });

  try {
    const live = await fetchJson(`/api/rzd/search?${params.toString()}`);
    if (live.status === "unavailable") {
      // Fallback не является критической ошибкой: приложение продолжает работать
      // на встроенных маршрутах и честно сообщает, что live-ответ недоступен.
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
  // Live-результаты добавляются ниже локальных карточек, чтобы пользователь видел
  // обе картины: что есть во встроенном каталоге и что ответил pass.rzd.ru.
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
  // Список маршрутов полностью перерисовывается после каждого поиска/выбора. Для
  // небольшого каталога это проще и надежнее, чем точечная синхронизация DOM.
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
    // Каждая карточка - кнопка, чтобы она была доступна с клавиатуры и сразу
    // работала как интерактивный элемент выбора маршрута.
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
  // Выбор маршрута может прийти с клика по линии карты или по карточке списка.
  // Поэтому вся логика синхронизации UI сосредоточена здесь.
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
  // Детальная панель показывает сводку, метрики и timeline остановок. Статус "в
  // движении" рассчитывается тем же способом, что и маркер на карте.
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
  // Пустое состояние нужно при первом открытии и при поиске без результатов.
  selectors.routeDetails.innerHTML = `
    <div class="empty-state">
      <strong>Выберите маршрут</strong>
      <span>Кликните по линии на карте или карточке рейса.</span>
    </div>
  `;
}

function renderStationList() {
  // Справочник станций помогает пользователю понять, какие station code заложены
  // во встроенный каталог и могут быть отправлены в live-proxy РЖД.
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
  // Popup маркера поезда не хранится в HTML, потому что он зависит от расчетной
  // позиции и пересоздается при каждом обновлении маркеров.
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
  // Масштабируем карту по всем координатам переданных маршрутов. Padding оставляет
  // визуальный воздух вокруг линий и не прижимает их к краям viewport.
  const points = routes.flatMap((route) => route.polyline);
  if (!points.length) return;
  // Перед fitBounds просим Leaflet перечитать размер контейнера. Это особенно важно
  // после поиска/сброса, когда sidebar мог изменить высоту layout, а карта должна
  // масштабировать маршрут относительно актуального viewport, а не старого размера.
  state.map.invalidateSize();
  state.map.fitBounds(L.latLngBounds(points), { padding: [42, 42] });
}

function fitToAllRoutes() {
  fitRoutes(state.data.routes);
}

function refreshMapSize() {
  // Первый вызов через requestAnimationFrame попадает в ближайший кадр после
  // текущего DOM/CSS-пересчета. Второй, через setTimeout, страхует более медленную
  // загрузку внешних CSS/шрифтов и изменение высоты контейнера после рендера.
  requestAnimationFrame(() => state.map?.invalidateSize());
  window.setTimeout(() => state.map?.invalidateSize(), 250);
}

function scheduleRealtimeUpdates() {
  // На всякий случай очищаем старый interval перед созданием нового: это защищает
  // от двойных таймеров при возможной повторной инициализации приложения.
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(updateTrainPositions, MINUTE);
}

function setStatus(message, isWarning = false) {
  // Статусная строка находится поверх карты и является основным способом сообщить
  // пользователю о загрузке, fallback live-proxy или результате поиска.
  selectors.statusText.textContent = message;
  selectors.statusText.classList.toggle("is-warning", isWarning);
}

function parseClock(clock) {
  // Формат HH:MM из каталога переводится в количество минут от полуночи, что
  // упрощает сравнение с текущим временем.
  const [hours, minutes] = clock.split(":").map(Number);
  return hours * 60 + minutes;
}

function formatDuration(minutes) {
  // Человекочитаемый формат длительности используется в карточках, деталях и popup.
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (!hours) return `${mins} мин`;
  return `${hours} ч ${mins.toString().padStart(2, "0")} мин`;
}

function formatOffset(minutes) {
  // В timeline первая остановка отображается как "старт", остальные - как смещение
  // от отправления, например "+3 ч 55 мин".
  if (minutes === 0) return "старт";
  return `+${formatDuration(minutes)}`;
}

function formatTime(date) {
  // Короткое локализованное время показывает, когда последний раз пересчитаны
  // расчетные позиции поездов.
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function formatRzdDate(dateValue) {
  // HTML input[type=date] возвращает строку без timezone. Если преобразовать ее в
  // Date, браузер может сдвинуть день из-за часового пояса. Поэтому строковый
  // вариант форматируем вручную.
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
  // Любые данные из JSON или внешнего API экранируем перед вставкой в innerHTML.
  // Это защищает интерфейс от случайной HTML-разметки и XSS в ответах источников.
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
