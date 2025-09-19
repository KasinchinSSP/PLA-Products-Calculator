/* calculator.js — FINAL (mobile-first, runtime fetch JSON, no uploads, no riders)
   - Fixes loading hang, robust fetch errors, works with Index (mobile UI)
   - Bottom sheet result + segmented buttons + chips + stepper
*/

(() => {
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // Elements
  const statusEl = $("status");
  const planEl = $("plan");
  const genderEl = $("gender");
  const ageEl = $("age");
  const sumEl = $("sumAssured");
  const sumHintEl = $("sum-assured-hint");
  const ageHintEl = $("age-hint");
  const resultEl = $("result-container");
  const dsVersionEl = $("dataset-version");
  const dsUpdatedEl = $("dataset-updated");

  const THB = new Intl.NumberFormat("th-TH");
  const state = {
    dataset: null,
    plansByKey: new Map(),
    modalFactors: {
      annual: 1,
      semiAnnual: 0.52,
      quarterly: 0.27,
      monthly: 0.09,
    }, // fallback
    highlightedModal: "annual", // annual | semi | quarter | month
  };

  // ---------- Utils ----------
  const setStatus = (msg, tone = "info") => {
    const tones = {
      info: "bg-white border-gray-200 text-gray-700",
      ok: "bg-green-50 border-green-200 text-green-800",
      warn: "bg-yellow-50 border-yellow-200 text-yellow-800",
      err: "bg-rose-50 border-rose-200 text-rose-800",
    };
    statusEl.className = `fade text-sm rounded-lg border p-3 ${
      tones[tone] || tones.info
    }`;
    statusEl.textContent = msg;
  };

  const coerceInt = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : NaN;
  };

  const ceilTo = (num, unit = 1) => Math.ceil(num / unit) * unit;

  // ---------- Validation ----------
  const validateDataset = (data) => {
    if (!data || typeof data !== "object")
      throw new Error("รูปแบบข้อมูลไม่ถูกต้อง");
    if (!Array.isArray(data.plans) || data.plans.length === 0)
      throw new Error("ไม่พบรายการแบบประกันในไฟล์");

    // modal factors (optional)
    const mf = data?.metadata?.modalFactors || data?.modalFactors;
    if (mf && typeof mf === "object") {
      const { annual, semiAnnual, quarterly, monthly } = mf;
      if (
        [annual, semiAnnual, quarterly, monthly].every(
          (x) => typeof x === "number" && x > 0
        )
      ) {
        state.modalFactors = { annual, semiAnnual, quarterly, monthly };
      }
    }

    data.plans.forEach((p, i) => {
      if (!p.planKey || !p.planName)
        throw new Error(`แผนลำดับที่ ${i + 1} ไม่มี planKey/planName`);
      if (
        !p.ageRange ||
        typeof p.ageRange.min !== "number" ||
        typeof p.ageRange.max !== "number"
      )
        throw new Error(`แผน ${p.planKey} ไม่มีช่วงอายุที่ถูกต้อง`);
      if (p.minSumAssured == null || p.minSumAssured <= 0)
        throw new Error(`แผน ${p.planKey} มี minSumAssured ไม่ถูกต้อง`);
      if (!p.calculationType)
        throw new Error(`แผน ${p.planKey} ไม่มี calculationType`);

      if (p.calculationType === "rateTable") {
        if (!Array.isArray(p.rates) || p.rates.length === 0)
          throw new Error(`แผน ${p.planKey} ไม่มีตารางอัตรา (rates)`);
        p.rates.forEach((r) => {
          if (typeof r.age !== "number")
            throw new Error(`แผน ${p.planKey} rate ขาดค่า age`);
          if (typeof r.male !== "number" || typeof r.female !== "number")
            throw new Error(`แผน ${p.planKey} rate ของชาย/หญิงไม่ถูกต้อง`);
        });
      } else if (p.calculationType === "fixedRatePer1000") {
        if (typeof p.fixedRate !== "number")
          throw new Error(`แผน ${p.planKey} ต้องกำหนด fixedRate`);
      } else {
        throw new Error(
          `แผน ${p.planKey} มี calculationType ไม่รองรับ: ${p.calculationType}`
        );
      }
    });

    return true;
  };

  // ---------- Engine ----------
  function lookupRate(plan, age, sex) {
    if (plan.calculationType === "fixedRatePer1000") return plan.fixedRate;
    const row = plan.rates.find((r) => r.age === age); // exact age table
    if (!row) return null;
    return sex === "male" ? row.male : row.female;
  }

  function applyDiscountPerThousand(plan, sumAssured, ratePerThousand) {
    if (!Array.isArray(plan.discounts) || plan.discounts.length === 0)
      return ratePerThousand;
    const sorted = [...plan.discounts].sort(
      (a, b) => (a.minSum || 0) - (b.minSum || 0)
    );
    let disc = 0;
    for (const d of sorted) {
      if (sumAssured >= (d.minSum || 0)) disc = d.discountPer1000 || 0;
    }
    const eff = ratePerThousand - disc;
    return eff < 0 ? 0 : eff;
  }

  function computeAnnualPremium(plan, sex, age, sumAssured) {
    if (age < plan.ageRange.min || age > plan.ageRange.max)
      throw new Error(
        `อายุไม่อยู่ในช่วงที่รองรับ (${plan.ageRange.min}–${plan.ageRange.max})`
      );
    if (sumAssured < plan.minSumAssured)
      throw new Error(
        `ทุนประกันต่ำกว่าขั้นต่ำ (${THB.format(plan.minSumAssured)} บาท)`
      );

    const baseRate = lookupRate(plan, age, sex);
    if (baseRate == null) {
      const years = (plan.rates || []).map((r) => r.age).sort((a, b) => a - b);
      const msg = years.length
        ? `อายุ ${age} ไม่มีเรตในตาราง สำหรับแผนนี้รองรับปี: ${years[0]}–${
            years[years.length - 1]
          }`
        : `อายุ ${age} ไม่มีเรตในตาราง`;
      throw new Error(msg);
    }

    const rateEff = applyDiscountPerThousand(plan, sumAssured, baseRate);
    const annual = ceilTo((sumAssured / 1000) * rateEff, 1);
    return { baseRate, rateEff, annual };
  }

  function computeModalPremiums(annual, modalFactors) {
    const semi = ceilTo(annual * modalFactors.semiAnnual, 1);
    const quarter = ceilTo(annual * modalFactors.quarterly, 1);
    const month = ceilTo(annual * modalFactors.monthly, 1);
    return { annual, semi, quarter, month };
  }

  // ---------- UI ----------
  function populatePlans(plans) {
    planEl.innerHTML = "";
    for (const p of plans) {
      const opt = document.createElement("option");
      opt.value = p.planKey;
      opt.textContent = p.planName;
      planEl.appendChild(opt);
    }
  }

  function updateHintsFor(plan) {
    sumEl.min = String(plan.minSumAssured || 0);
    sumEl.placeholder = `ไม่น้อยกว่า ${THB.format(plan.minSumAssured)} บาท`;
    sumHintEl.textContent = `ขั้นต่ำ: ${THB.format(plan.minSumAssured)} บาท`;

    ageEl.min = String(plan.ageRange?.min ?? 0);
    ageEl.max = String(plan.ageRange?.max ?? 120);
    ageHintEl.textContent = `ช่วงอายุที่รับ: ${plan.ageRange.min}–${plan.ageRange.max} ปี`;

    if (plan.calculationType === "rateTable" && Array.isArray(plan.rates)) {
      const minAge = Math.min(...plan.rates.map((r) => r.age));
      const maxAge = Math.max(...plan.rates.map((r) => r.age));
      ageHintEl.textContent += ` • ตารางเรตรายปี: ${minAge}–${maxAge}`;
    }
  }

  function renderResult({ plan, sex, age, sumAssured, breakdown, modal }) {
    const inner = `
      <div class=\"flex items-center justify-between mb-3\">
        <h3 class=\"text-lg font-semibold text-gray-800\">ผลการคำนวณ</h3>
        <span class=\"text-xs text-gray-500\">หน่วย: บาท</span>
      </div>

      <div class=\"grid grid-cols-1 md:grid-cols-2 gap-3 text-sm\">
        <div><span class=\"text-gray-500\">แบบประกัน:</span> <span class=\"font-medium\">${
          plan.planName
        }</span></div>
        <div><span class=\"text-gray-500\">ทุนประกัน:</span> <span class=\"font-medium\">${THB.format(
          sumAssured
        )}</span></div>
        <div><span class=\"text-gray-500\">เพศ:</span> <span class=\"font-medium\">${
          sex === "male" ? "ชาย" : "หญิง"
        }</span></div>
        <div><span class=\"text-gray-500\">อายุ:</span> <span class=\"font-medium\">${age} ปี</span></div>
      </div>

      <div class=\"mt-4 rounded-lg bg-white border p-4 text-sm\">
        <div class=\"flex items-center justify-between\">
          <div class=\"text-gray-500\">อัตราฐานต่อทุน 1,000</div>
          <div class=\"font-semibold\">${THB.format(breakdown.baseRate)}</div>
        </div>
        <div class=\"flex items-center justify-between mt-1\">
          <div class=\"text-gray-500\">อัตราหลังหักส่วนลดขั้นบันได (ถ้ามี)</div>
          <div class=\"font-semibold\">${THB.format(breakdown.rateEff)}</div>
        </div>
        <hr class=\"my-3\"/>

        <div class=\"overflow-hidden rounded-md border\">
          <table class=\"min-w-full text-sm\">
            <thead class=\"bg-gray-50 text-gray-600\">
              <tr>
                <th class=\"text-left px-3 py-2\">งวดชำระ</th>
                <th class=\"text-right px-3 py-2\">เบี้ย (บาท)</th>
                <th class=\"text-right px-3 py-2 text-xs font-normal\">ตัวคูณ</th>
              </tr>
            </thead>
            <tbody>
              <tr class=\"border-t\" data-modal-row=\"annual\">
                <td class=\"px-3 py-2\">รายปี</td>
                <td class=\"px-3 py-2 text-right font-semibold\">${THB.format(
                  modal.annual
                )}</td>
                <td class=\"px-3 py-2 text-right\">${
                  state.modalFactors.annual
                }</td>
              </tr>
              <tr class=\"border-t\" data-modal-row=\"semi\">
                <td class=\"px-3 py-2\">ราย 6 เดือน</td>
                <td class=\"px-3 py-2 text-right font-semibold\">${THB.format(
                  modal.semi
                )}</td>
                <td class=\"px-3 py-2 text-right\">${
                  state.modalFactors.semiAnnual
                }</td>
              </tr>
              <tr class=\"border-t\" data-modal-row=\"quarter\">
                <td class=\"px-3 py-2\">ราย 3 เดือน</td>
                <td class=\"px-3 py-2 text-right font-semibold\">${THB.format(
                  modal.quarter
                )}</td>
                <td class=\"px-3 py-2 text-right\">${
                  state.modalFactors.quarterly
                }</td>
              </tr>
              <tr class=\"border-t\" data-modal-row=\"month\">
                <td class=\"px-3 py-2\">รายเดือน</td>
                <td class=\"px-3 py-2 text-right font-semibold\">${THB.format(
                  modal.month
                )}</td>
                <td class=\"px-3 py-2 text-right\">${
                  state.modalFactors.monthly
                }</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>`;

    resultEl.innerHTML = `<div class="sheet p-4"><div class="grabber"></div>${inner}</div>`;
    resultEl.classList.add("open");

    const row = resultEl.querySelector(
      `[data-modal-row="${state.highlightedModal}"]`
    );
    row?.classList.add("bg-indigo-50");
  }

  // ---------- Events ----------
  planEl.addEventListener("change", () => {
    const plan = state.plansByKey.get(planEl.value);
    if (plan) updateHintsFor(plan);
  });

  document.getElementById("calculate-btn").addEventListener("click", (e) => {
    e.preventDefault();
    try {
      const plan = state.plansByKey.get(planEl.value);
      if (!plan) throw new Error("ยังไม่พบข้อมูลแบบประกัน");

      const sex = genderEl.value === "male" ? "male" : "female";
      const age = coerceInt(ageEl.value);
      const sumAssured = coerceInt(sumEl.value);

      if (!Number.isFinite(age)) throw new Error("กรุณาระบุอายุเป็นตัวเลข");
      if (!Number.isFinite(sumAssured))
        throw new Error("กรุณาระบุทุนประกันเป็นตัวเลข");

      const breakdown = computeAnnualPremium(plan, sex, age, sumAssured);
      const modal = computeModalPremiums(breakdown.annual, state.modalFactors);

      renderResult({ plan, sex, age, sumAssured, breakdown, modal });
      setStatus("คำนวณสำเร็จ", "ok");
    } catch (err) {
      console.error(err);
      setStatus(err.message || "เกิดข้อผิดพลาดในการคำนวณ", "err");
      resultEl.classList.remove("open");
      resultEl.innerHTML = "";
    }
  });

  // Close bottom sheet when clicking outside content
  resultEl.addEventListener("click", (e) => {
    if (e.target.id === "result-container") resultEl.classList.remove("open");
  });
  // ESC to close
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") resultEl.classList.remove("open");
  });

  // ---------- Mobile helpers ----------
  function attachMobileUI() {
    // Gender segmented -> sync hidden select
    $$(".gender-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".gender-btn").forEach((b) =>
          b.setAttribute("aria-selected", "false")
        );
        btn.setAttribute("aria-selected", "true");
        genderEl.value = btn.dataset.g;
      });
    });
    document
      .querySelector('.gender-btn[data-g="female"]')
      ?.setAttribute("aria-selected", "true");

    // Age stepper
    $("age-dec")?.addEventListener("click", () => {
      const v = parseInt(ageEl.value || "0", 10) || 0;
      ageEl.value = String(Math.max(0, v - 1));
    });
    $("age-inc")?.addEventListener("click", () => {
      const v = parseInt(ageEl.value || "0", 10) || 0;
      ageEl.value = String(v + 1);
    });

    // Sum chips
    $$(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        sumEl.value = chip.dataset.sa;
      });
    });

    // Modal segmented (highlight only)
    $$(".modal-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".modal-btn").forEach((b) =>
          b.setAttribute("aria-selected", "false")
        );
        btn.setAttribute("aria-selected", "true");
        state.highlightedModal = btn.dataset.modal; // annual|semi|quarter|month
      });
    });
    document
      .querySelector('.modal-btn[data-modal="annual"]')
      ?.setAttribute("aria-selected", "true");
  }

  // ---------- Boot ----------
  async function boot() {
    if (location.protocol === "file:") {
      console.warn("เปิดผ่าน file:// — เบราว์เซอร์บางตัวบล็อก fetch ไฟล์โลคัล");
    }
    try {
      const res = await fetch("./pla_insurance.json", { cache: "no-cache" });
      if (!res.ok) {
        throw new Error(
          `โหลดข้อมูลไม่สำเร็จ (${res.status} ${res.statusText}). ตรวจสอบว่าไฟล์ pla_insurance.json อยู่โฟลเดอร์เดียวกับ index.html`
        );
      }

      let data;
      try {
        data = await res.json();
      } catch (e) {
        throw new Error("ไม่สามารถอ่าน JSON ได้ (รูปแบบไม่ถูกต้อง)");
      }

      validateDataset(data);
      state.dataset = data;

      state.plansByKey.clear();
      data.plans.forEach((p) => state.plansByKey.set(p.planKey, p));

      populatePlans(data.plans);
      const firstPlan = data.plans[0];
      if (firstPlan) updateHintsFor(firstPlan);

      if (dsVersionEl)
        dsVersionEl.textContent = data?.fileInfo?.version
          ? `v${data.fileInfo.version}`
          : "v—";
      if (dsUpdatedEl)
        dsUpdatedEl.textContent = data?.fileInfo?.lastUpdated
          ? `อัปเดต: ${data.fileInfo.lastUpdated}`
          : "อัปเดต —";

      setStatus(`โหลดข้อมูลสำเร็จ`, "ok");
    } catch (err) {
      console.error(err);
      if (location.protocol === "file:") {
        setStatus(
          "โหลดข้อมูลไม่สำเร็จจากไฟล์โลคัล — โปรดเปิดผ่านเว็บเซิร์ฟเวอร์ (เช่น VSCode Live Server, npx serve, หรือ python -m http.server)",
          "err"
        );
      } else {
        setStatus(err.message || "เกิดข้อผิดพลาดในการโหลดข้อมูล", "err");
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    attachMobileUI();
    boot();
  });
})();
