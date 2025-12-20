let timestamp_re = /^(\d\d):(\d\d):(\d\d) /;
let SEC = 1000;
let MIN = 60 * SEC;

let last_heartbeat = await loadText('data/heartbeat.txt');
let config = await loadJSON('config.json');
let categories = config.categories;
for (let cat of categories)
  cat.patterns = cat.patterns.map(str => new RegExp(str, 'i'));
let unknown_cat = {name: 'unknown'};
let infer_prev_cat_patterns = config.infer_previous_category.patterns.map(str => new RegExp(str, 'i'));

let bins;

let view_day = new Date();
document.addEventListener('keyup', function(event) {
  if (event.key == 'ArrowLeft') {
    view_day.setDate(view_day.getDate() - 1);
    loadDay(view_day);
  } else if (event.key == 'ArrowRight') {
    view_day.setDate(view_day.getDate() + 1);
    loadDay(view_day);
  }
});

await loadDay(view_day);
window.addEventListener('resize', renderBins.bind(null, bins));

async function loadDay(view_day) {
  let proj_to_min = await loadJSON(`data/${getISODate(view_day)}-project-min.json`);

  let log = await loadText(`data/${getISODate(view_day)}-activity.log`);
  let lines = log.split('\n');

  bins = groupIntoBins(lines);
  setBinLabels(bins);
  renderBins(bins);

  let div = document.getElementById('details');
  div.replaceChildren();
  for (let cat of categories) {
    if (cat.daycast_project_id) {
      let clocked_min = proj_to_min[cat.daycast_project_id];
      if (!clocked_min)
        continue;

      let tracked_ms = 0;
      for (let bin of bins)
        if (bin.cat == cat)
          tracked_ms += bin.duration;
      
      let tracked_min = Math.round(tracked_ms / MIN);
      let pct = Math.round(tracked_min / clocked_min * 100);
      let p = document.createElement('p');
      p.innerText = `${pct}% ${cat.name}`;
      div.appendChild(p);
    }
  }
}
// renderBinText(bins);

function groupIntoBins(lines) {
  let bins = [];
  let curr_bin, prev_bin;
  for (let line of lines) {
    if (!line)
      continue;

    if (line.endsWith('activity tracking stopped')) {
      assert(curr_bin, 'Unexpected tracking stopped when there was no current bin');
      curr_bin.end = parseTimestamp(line);
      continue;
    }

    let cat = getCategory(line);
    if (cat == unknown_cat && matchesPattern(line, infer_prev_cat_patterns)) {
      if (curr_bin?.cat == unknown_cat)
        cat = prev_bin?.cat || unknown_cat;
      else
        cat = curr_bin?.cat || unknown_cat;
    }

    if (cat == curr_bin?.cat && !curr_bin?.end) {
      curr_bin.lines.push(line);
    }
    else {
      prev_bin = curr_bin;
      curr_bin = {cat: cat, lines: [line], start: parseTimestamp(line)};
      
      // implicitly end the previous bin if it didn't explicitly end
      if (prev_bin && !prev_bin.end)
        prev_bin.end = curr_bin.start;

      bins.push(curr_bin);
    }
  }

  last_heartbeat = new Date(last_heartbeat);

  // implicitly end the final bin now
  let last_bin = bins[bins.length-1];
  if (!last_bin.end) {
    assert(getISODate(last_heartbeat) == getISODate(view_day), 'expected last heartbeat to match the date of the file with the missing stop-line');
    last_bin.end = last_heartbeat;
  }

  for (let bin of bins) {
    bin.duration = bin.end - bin.start;
  }
  return bins;
}

// function calcBinDurations(bins) {
//   for (let n = 0; n < bins.length; n++) {
//     let bin = bins[n];
//     bin.start = parseTimestamp(bin.lines[0]);
//     let next_bin = bins[n+1];
//     if (next_bin)
//       bin.end = parseTimestamp(next_bin.lines[0]);
//     else
//       bin.end = parseTimestamp(bin.lines[bin.lines.length-1]);

//     bin.duration = bin.end - bin.start;
//   }
// }

function setBinLabels(bins) {
  for (let bin of bins) {
    let dur_sec = Math.round(bin.duration/1000);
    let dur_min = Math.floor(dur_sec / 60);
    dur_sec -= dur_min * 60;
    let dur_hr = Math.floor(dur_min / 60);
    dur_min -= dur_hr * 60;

    let dur_str;
    if (dur_hr || dur_min)
      dur_str = `${dur_hr}:${pad2(dur_min)}`;
    else
      dur_str = `${dur_sec}s`;

    bin.label = `${dur_str} ${bin.cat.name} (${prettyTimeRange(bin.start, bin.end)})`;
  }
}

function renderBinText(bins) {
  let div = document.getElementById('details');
  div.replaceChildren();
  for (let bin of bins) {
    let p = document.createElement('p');
    p.textContent = bin.label;
    
    p.addEventListener('click', function() {
      renderLines(bin.lines);
    });
    p.className = 'text_bin';
    div.appendChild(p);
  }
}

function renderLines(lines) {
  let div = document.getElementById('details');
  div.replaceChildren();
  for (let line of lines) {
    let p = document.createElement('p');
    p.textContent = line;
    div.appendChild(p);
  }
}

function renderBins(bins) {
  let avail_width = window.innerWidth;
  let div = document.getElementById('bars');
  div.replaceChildren();

  let total_duration = bins[bins.length-1].end - bins[0].start;
  let px_per_ms = avail_width / total_duration;
  let prev_bin;
  for (let bin of bins) {
    // create "gap" div to hold the empty space between
    if (prev_bin && prev_bin.end != bin.start) {
      let gap = document.createElement('div');
      gap.className = 'block gap';
      gap.style.width = `${(bin.start - prev_bin.end) * px_per_ms}px`;
      div.appendChild(gap);
    }

    let block = document.createElement('div');
    block.className = `block ${bin.cat.name.replaceAll(' ', '_')}`;
    block.style.width = `${bin.duration * px_per_ms}px`;
    block.style.backgroundColor = bin.cat.color;

    block.addEventListener('click', function() {
      renderLines(bin.lines);
    });
    div.appendChild(block);
    prev_bin = bin;
  }
}


// helper functions

function prettyTimeRange(start, end) {
  let start_ampm = getAMPM(start);
  let end_ampm = getAMPM(end);
  let start_hr = get12Hr(start);
  let end_hr = get12Hr(end);
  let start_min = pad2(start.getMinutes());
  let end_min = pad2(end.getMinutes());

  let str = `${start_hr}:${start_min}`;
  if (start_ampm == end_ampm) {
    if (start_hr == end_hr) {
      if (start_min == end_min) {
        str += `${start_ampm}`;
      }
      else {
        str += `-${end_min}${start_ampm}`;
      }
    }
    else {
      str += `-${end_hr}:${end_min}${start_ampm}`;
    }
  }
  else {
    str += `${start_ampm}-${end_hr}:${end_min}${end_ampm}`;
  }
  return str;
}

function getAMPM(dt) {
  let hours = dt.getHours();
  if (hours < 12)
    return 'am';
  else
    return 'pm';
}

function get12Hr(dt) {
  let hours = dt.getHours();
  if (hours == 0)
    return 12;
  else if (hours > 12)
    return hours - 12;
  else
    return hours;
}

function parseTimestamp(line) {
  let match = timestamp_re.exec(line);
  assert(match, `line didn't begin with timestamp: ${line}`);
  let dt = new Date(view_day.toISOString());
  dt.setHours(parseInt(match[1]));
  dt.setMinutes(parseInt(match[2]));
  dt.setSeconds(parseInt(match[3]));
  dt.setMilliseconds(0);
  return dt;
}

function getCategory(line) {
  let curr_cat;
  for (let cat of categories) {
    if (matchesPattern(line, cat.patterns)) {
      if (curr_cat) {
        if (curr_cat.is_secondary)
          curr_cat = cat;
        else
          assert(cat.is_secondary, `line matches multiple primary categories: ${curr_cat?.name} and ${cat.name} (${line})`);
      }
      else {
        curr_cat = cat;
      }
    }
  }
  return curr_cat || unknown_cat;
}

function matchesPattern(line, patterns) {
  for (let pattern of patterns) {
    if (pattern.test(line)) {
      return true;
    }
  }
  return false;
}

async function loadText(filename) {
  let res = await load(filename);
  return await res.text();
}

async function loadJSON(filename) {
  let res = await load(filename);
  return await res.json();
}

async function load(filename) {
  let res = await fetch(filename);
  if (!res.ok)
    throw new Error(`HTTP error ${res.status}`);
  return res;
}

function assert(val, msg) {
  if (!val)
    throw new Error(msg);
}


// TODO: fix DRY violation w/ activity-tracker.js ?
function getISODate(dt) {
  if (!dt)
    dt = new Date();
  return `${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}`;
}

function pad2(n) {
  if (n < 10)
    return "0" + n;
  else
    return n;
}
