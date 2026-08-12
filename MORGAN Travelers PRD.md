## **MORGAN Travelers Product Requirements Document (PRD)**

**Platform:** Progressive Web App (PWA) / iOS & Android via WebKit

### **1\. Executive Summary**

The MORGAN Travelers app provides a high-performance, free-to-use transit trip planner and live bus tracking tool tailored for Hong Kong commuters and dedicated bus spotters. Utilizing a serverless architecture, the application operates natively on the user's device via WebAssembly (WASM). By deploying as a Progressive Web App (PWA) hosted on Cloudflare Pages, MORGAN Travelers circumvents traditional app store limitations, ensuring frictionless distribution, zero-cost scaling, and near-native execution speeds without backend server overhead.

### **2\. Objectives & Goals**

* **Zero-Cost Infrastructure:** Eliminate backend server costs and API subscription fees by operating entirely client-side, utilizing Cloudflare Pages for free bandwidth egress.  
* **Frictionless Distribution:** Bypass the Apple App Store and TestFlight restrictions using a PWA ("Add to Home Screen") deployment model.  
* **High Performance:** Execute complex routing and tracking algorithms at near-native speeds using Rust-compiled WebAssembly (WASM), leveraging Cross-Origin Isolation for multithreading.  
* **Human-Centric Routing:** Prioritize the "simplest and fastest" routes, balancing mathematical efficiency with realistic commuter behavior (e.g., minimizing transfers).  
* **User-Centric Flexibility:** Serve both fast-moving commuters and dedicated "Bus Fans" (巴士迷) with dynamic data visualization toggles.

### **3\. Architecture & Data Flow**

#### **3.1. Static Routing Data (The Baseline)**

* **Engine:** wheels-router-nano (Rust-based, MIT Licensed) utilizing the RAPTOR algorithm.  
* **Data Pipeline:** A GitHub Actions workflow leveraging a fork of wheelstransit/hongkong-community-gtfs.  
  * The workflow automatically scrapes Hong Kong Open Data, generates standard GTFS, and immediately compiles it into the hyper-optimized GTFS-Dense format.  
* **Deployment:** The automated pipeline pushes the final binary directly to Cloudflare Pages. This maintains a strict licensing boundary, keeping the frontend codebase completely independent from the GPL-licensed processing tools.  
* **Delivery:** The browser downloads the GTFS-Dense file from Cloudflare's Hong Kong edge nodes for instant, low-latency WASM execution.

#### **3.2. Real-Time Data (The Live Feed)**

* **ETA Data:** Fetched directly via client-side JavaScript fetch() from Hong Kong Open Data APIs (e.g., DATA.GOV.HK endpoints).  
* **Traffic Data:** Fetched directly from the HK Transport Department's Traffic Speed Map API (CSV format).

#### **3.3. Map Data (The Visual Layer)**

* **Data Source:** OpenStreetMap (OSM) for zero-cost, community-driven geographic data.  
* **BaseMap Provider:** Protomaps `(https://github.com/protomaps/basemaps)`  
* **Execution:** Hosted statically as a `.pmtiles` archive on Cloudflare Pages. The PWA utilizes HTTP Range Requests to fetch vector tiles on-demand directly from the static file, eliminating the need for a traditional rendering server while maintaining full vector crispness.

### **4\. Core Features**

#### **4.1. Human-Optimized Routing Logic**

To prevent the engine from returning mathematically fast but physically exhausting routes, the RAPTOR algorithm implementation includes behavioral adjustments:

* **Transfer Penalties:** An artificial time penalty (e.g., \+10 minutes) is applied per vehicle transfer to bias the algorithm toward direct routes.  
* **Pareto Filtering:** The WASM binary generates a Pareto Front (balancing transfer count vs. travel time), allowing the JavaScript frontend to select the most logical, commuter-friendly route rather than defaulting to the absolute shortest time.

#### **4.2. MORGAN Travelers Live Bus Position Engine (Nano ML)**

A client-side predictive tracking system that translates static ETA countdowns into smooth map movements.

* **Data Stitching:** Groups multiple stop ETAs to identify a unique, moving vehicle.  
* **Kalman Filter:** A lightweight, WASM-executed discrete Kalman filter predicting bus location and velocity.  
* **Traffic Injection:** Modifies the Kalman matrix using real-world speed multipliers derived from the HK Traffic Speed Map CSV.

#### **4.3. Dual-Loop Fetch Strategy**

To optimize battery life, network bandwidth, and API limits, the engine uses a hybrid visibility-aware fetch loop.

| Loop | Trigger / Frequency | Action | Condition |
| :---- | :---- | :---- | :---- |
| **Instant Sync** | On visibilitychange | Fetch ETAs \+ Traffic CSV | Executes immediately upon app visibility (opening or un-minimizing). |
| **Pulse** | Every 1 Minute | Fetch ETAs | Uses *cached* traffic data (2-4 min lag) for lightweight calculation. |
| **Baseline** | Every 5 Minutes | Fetch ETAs \+ Traffic CSV | Synchronizes with the official HK Transport Dept 5-minute update cycle. |

*Gatekeeper Check:* All interval timers must pass a document.visibilityState \=== 'visible' check before executing network requests to prevent background battery and data drain.

#### **4.4. Interface & View Modes**

Designed with a geometric sans-serif aesthetic (Montserrat) and sleek transparency elements.

* **Standard Mode:** Optimized for quick glances. Displays simple ETA countdowns (e.g., "3 min") and smooth, predictive map markers.  
* **Bus Spotter Mode (巴士迷 Mode):** A toggleable raw-data view overlaying technical specifications (wheelchair accessibility, exact timestamps, vehicle capacity) directly onto the map interface for extended tracking sessions (*Bus Spotter Mode idea cancelled.)

### **5\. Technical Stack & Deployment**

* **Frontend:** HTML, CSS, JavaScript (PWA Manifest, Service Workers for asset caching).  
* **Backend/Routing:** Rust compiled to WebAssembly (wheels-router-nano).  
* **CI/CD:** GitHub Actions (forked hongkong-community-gtfs pipeline).  
* **Hosting & CDN:** Cloudflare Pages (utilizing a \_headers configuration file to enforce Cross-Origin-Embedder-Policy and Cross-Origin-Opener-Policy for WASM multithreading support).

**6\. Edge Cases & Handling**

* **Terminal Layover:** If a bus is at the initial GTFS-Dense polyline node and the ETA is \> 0 minutes, the location marker must remain locked at the terminus, bypassing traffic interpolation to prevent the UI marker from "creeping" forward prematurely.  
* **Network Drop:** If the 1-minute ETA fetch fails due to spotty 5G, the Kalman filter will "coast" using the historical speed of the current road segment until connectivity resumes, keeping the map responsive.