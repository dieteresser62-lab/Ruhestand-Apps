'use strict';

/**
 * Gemeinsame Logik-Engine für das Ruhestandsmodell
 * Version: 30.2 (Inflations-Fix & Log-Erweiterung)
 * ausgelagert am 11.10.2025
 */
const Ruhestandsmodell_v30 = {
    VERSION: 'v30.2', // Version erhöht

    CONFIG: {
        STAGFLATION_INFLATION_THRESHOLD: 4,
        ANTI_PSEUDO_ACCURACY: {
            QUANTIZE_REFILL_STEP: 1000,
            RATE_CHANGE_MAX_UP_PP: 2.5,
            RATE_CHANGE_AGILE_UP_PP: 4.5,
            RATE_CHANGE_MAX_DOWN_PP: 3.5,
            FLEX_RATE_SMOOTHING_ALPHA: 0.35
        },
        PROFIL_MAP: {
            'sicherheits-dynamisch': {
                isDynamic: true,
                minRunwayMonths: 24,
                runway: {
                    'peak': { total: 48 },
                    'hot_neutral': { total: 36 },
                    'bear': { total: 60 }, 'stagflation': { total: 60 },
                    'recovery_in_bear': { total: 48 },
                    'recovery': { total: 48 }
                },
                reinvestThresholdFactor: 1.25,
                reinvestTargetFactor: 1.1,
            }
        },
        SCENARIO_TEXT: {
            peak_hot: "Markt heiß gelaufen", peak_stable: "Stabiler Höchststand", recovery: "Best. Erholung", bear_deep: "Tiefer Bär",
            corr_young: "Junge Korrektur", side_long: "Seitwärts Lang", recovery_in_bear: "Erholung im Bärenmarkt"
        },
        REGIME_MAP: {
            peak_hot: 'peak', peak_stable: 'hot_neutral',
            side_long: 'hot_neutral', recovery: 'recovery',
            corr_young: 'recovery', bear_deep: 'bear',
            recovery_in_bear: 'recovery_in_bear'
        }
    },

    analyzeMarket(input) {
        const endeVJ_eff = input.endeVJ;
        const abstandVomAthProzent = (input.ath > 0 && endeVJ_eff > 0) ? ((input.ath - endeVJ_eff) / input.ath) * 100 : 0;
        const perf1Y = (input.endeVJ_1 > 0) ? ((endeVJ_eff - input.endeVJ_1) / input.endeVJ_1) * 100 : 0;
        let monateSeitAth = input.jahreSeitAth * 12;
        if (abstandVomAthProzent > 0 && input.jahreSeitAth === 0) monateSeitAth = 12;
        
        let sKey, reasons = [];
        if (abstandVomAthProzent <= 0) {
            sKey = (perf1Y >= 10) ? 'peak_hot' : 'peak_stable';
            reasons.push('Neues Allzeithoch');
            if(perf1Y >= 10) reasons.push('Starkes Momentum (>10%)');
        } else if (abstandVomAthProzent > 20) {
            sKey = 'bear_deep';
            reasons.push(`ATH-Abstand > 20% (${abstandVomAthProzent.toFixed(1)}%)`);
        } else if (abstandVomAthProzent > 10 && perf1Y > 10 && monateSeitAth > 6) {
            sKey = 'recovery';
            reasons.push('Starkes Momentum nach Korrektur');
        } else if (abstandVomAthProzent <= 15 && monateSeitAth <= 6) {
            sKey = 'corr_young';
            reasons.push('Kürzliche, leichte Korrektur');
        } else {
            sKey = 'side_long';
            reasons.push('Seitwärtsphase');
        }

        if (sKey === 'bear_deep' || sKey === 'recovery') {
            const last4years = [input.endeVJ, input.endeVJ_1, input.endeVJ_2, input.endeVJ_3].filter(v => v > 0);
            const lowPoint = last4years.length > 0 ? Math.min(...last4years) : 0;
            const rallyFromLow = lowPoint > 0 ? ((input.endeVJ - lowPoint) / lowPoint) * 100 : 0;

            const isRecoveryInBear = (perf1Y >= 15 || rallyFromLow >= 30) && abstandVomAthProzent > 15;
            if (isRecoveryInBear) {
                sKey = 'recovery_in_bear';
                reasons.push(`Erholung im Bärenmarkt (Perf 1J: ${perf1Y.toFixed(0)}%, Rally v. Tief: ${rallyFromLow.toFixed(0)}%)`);
            }
        }
        
        const real1Y = perf1Y - input.inflation;
        const isStagflation = input.inflation >= this.CONFIG.STAGFLATION_INFLATION_THRESHOLD && real1Y < 0;
        if(isStagflation) reasons.push(`Stagflation (Inflation ${input.inflation}% > Realrendite ${real1Y.toFixed(1)}%)`);
        
        return { perf1Y, abstandVomAthProzent, sKey, isStagflation, szenarioText: (this.CONFIG.SCENARIO_TEXT[sKey] || "Unbekannt") + (isStagflation ? " (Stagflation)" : ""), reasons };
    },
    
    determineSpending({market, lastState, inflatedFloor, inflatedFlex, round5, runwayMonths, liquidNow, profile, depotValue, inputsCtx, totalWealth}) {
        const diagnosis = { decisionTree: [], guardrails: [], keyParams: {}, general: {} };
        const addDecision = (step, impact, status, severity = 'info') => diagnosis.decisionTree.push({ step, impact, status, severity });

        const AP = this.CONFIG.ANTI_PSEUDO_ACCURACY;
        const REGIME_MAP = this.CONFIG.REGIME_MAP;

        const firstRun = !lastState || !lastState.initialized;
        if (firstRun) {
            lastState = {
                flexRate: 100, lastMarketSKey: market.sKey, lastTotalBudget: inflatedFloor + inflatedFlex + (inputsCtx?.pensionAnnual ?? 0),
                pensionAnnual: (inputsCtx?.pensionAnnual ?? 0), peakRealVermoegen: totalWealth, cumulativeInflationFactor: 1,
                initialized: true, alarmActive: false, lastInflationAppliedAtAge: 0
            };
            addDecision("System-Initialisierung", "Starte mit 100% Flex-Rate und setze initialen Vermögens-Peak.", "active");
        }

        const regime = REGIME_MAP[market.sKey];
        diagnosis.general = { marketSKey: market.sKey, marketSzenario: market.szenarioText };
        
        const cumulativeInflationFactor = lastState.cumulativeInflationFactor || 1;
        const realVermoegen = totalWealth / cumulativeInflationFactor;
        const peakRealVermoegen = lastState.peakRealVermoegen || realVermoegen;
        const realerDepotDrawdown = (peakRealVermoegen > 0) ? (peakRealVermoegen - realVermoegen) / peakRealVermoegen : 0;

        let vorlaeufigeFlexRate = (AP.FLEX_RATE_SMOOTHING_ALPHA * 100 + (1 - AP.FLEX_RATE_SMOOTHING_ALPHA) * (lastState.flexRate || 100));
        const vorlaeufigeEntnahme = inflatedFloor + (inflatedFlex * (vorlaeufigeFlexRate / 100));
        const entnahmequoteDepot = depotValue > 0 ? vorlaeufigeEntnahme / depotValue : 0;
        
        diagnosis.keyParams = { peakRealVermoegen, currentRealVermoegen: realVermoegen, cumulativeInflationFactor, entnahmequoteDepot, realerDepotDrawdown, runwayMonths };
        
        let geglätteteFlexRate;
        let kuerzungQuelle;
        let endgueltigeEntnahme;
        let alarmAktivInDieserRunde = false;
        
        const ALARM_QUOTE = 0.055;
        const ALARM_DRAWDOWN = 0.25;
        const VORSICHT_QUOTE = 0.045;
        const crisisGate = (market.sKey === 'bear_deep');
        const runwayThin = runwayMonths < 24;
        
        let alarmWarAktiv = !!lastState?.alarmActive;
        
        const noNewLowerYearlyCloses = inputsCtx.marketData.endeVJ > Math.min(inputsCtx.marketData.endeVJ_1, inputsCtx.marketData.endeVJ_2);
        const isPeakOrHot = (market.sKey === 'peak_hot' || market.sKey === 'peak_stable' || market.sKey === 'side_long');
        const okQuote  = entnahmequoteDepot <= ALARM_QUOTE;
        const okDrawdn = realerDepotDrawdown <= 0.15;

        if (alarmWarAktiv && isPeakOrHot && (okQuote || okDrawdn)) {
            alarmWarAktiv = false;
            addDecision("Alarm-Deeskalation (Peak)", "Markt erholt, Drawdown/Quote unkritisch. Alarm wird beendet.", "active", "guardrail");
        }
        
        if (alarmWarAktiv && market.sKey === 'recovery_in_bear') {
            const okRunway = runwayMonths >= (profile.minRunwayMonths + 6);
            const okDrawdnRecovery = realerDepotDrawdown <= (ALARM_DRAWDOWN - 0.05);
            if ((okQuote || okRunway || okDrawdnRecovery) && noNewLowerYearlyCloses) {
                alarmWarAktiv = false;
                addDecision("Alarm-Deeskalation (Recovery)", "Bedingungen für Entspannung sind erfüllt (Quote, Drawdown, kein neues Zwischentief). Alarm wird beendet.", "active", "guardrail");
            }
        }

        if (alarmWarAktiv && market.sKey === 'bear_deep') {
          const okRunway = runwayMonths >= (profile.minRunwayMonths + 6);
          const okDrawdnStable = realerDepotDrawdown <= 0.10;
          const okQuoteStable  = entnahmequoteDepot <= VORSICHT_QUOTE;
          if ((okDrawdnStable || okQuoteStable) && okRunway && noNewLowerYearlyCloses) {
            alarmWarAktiv = false;
            addDecision("Alarm-Deeskalation (Bear stabil)", 
              "Drawdown/Quote unkritisch, Runway stabil, kein neues Zwischentief. Alarm wird beendet.", 
              "active", "guardrail");
          }
        }
        
        if (!alarmWarAktiv && crisisGate && ((entnahmequoteDepot > ALARM_QUOTE && runwayThin) || realerDepotDrawdown > ALARM_DRAWDOWN)) {
            alarmAktivInDieserRunde = true;
            addDecision("Alarm-Aktivierung!", `Bärenmarkt und kritische Schwelle überschritten (Quote/Drawdown). Alarm-Modus AN.`, "active", "alarm");
        }

        diagnosis.general.alarmActive = alarmAktivInDieserRunde || alarmWarAktiv;

        if (alarmAktivInDieserRunde || alarmWarAktiv) {
            kuerzungQuelle = "Guardrail (Alarm)";
            const prevFlexRate = lastState?.flexRate ?? 100;
            if(alarmAktivInDieserRunde) { 
                const shortfallRatio = Math.max(0, (profile.minRunwayMonths - runwayMonths) / profile.minRunwayMonths);
                const zielCut = Math.min(10, Math.round(10 + 20 * shortfallRatio));
                geglätteteFlexRate = Math.max(35, prevFlexRate - zielCut);
                addDecision("Anpassung im Alarm-Modus", `Flex-Rate wird auf ${geglätteteFlexRate.toFixed(1)}% gesetzt (Grund: ${kuerzungQuelle}).`, "active", "alarm");
            } else {
                 geglätteteFlexRate = prevFlexRate; 
                 addDecision("Anpassung im Alarm-Modus", `Alarm-Modus ist weiterhin aktiv, aber keine neue Verschärfung. Rate bleibt bei ${geglätteteFlexRate.toFixed(1)}% (Grund: ${kuerzungQuelle}).`, "active", "alarm");
            }
            endgueltigeEntnahme = inflatedFloor + (inflatedFlex * (geglätteteFlexRate / 100));

        } else {
            const regimeRank = (sKey) => {
                if (!sKey) return -1; const r = REGIME_MAP[sKey];
                if (r === 'bear') return 0; if (r === 'recovery_in_bear') return 1; if (r === 'recovery') return 2;
                if (r === 'hot_neutral') return 3; if (r === 'peak') return 4; return -1;
            };
            const currentRegimeRank = regimeRank(market.sKey);
            const lastRegimeRank = regimeRank(lastState?.lastMarketSKey);
            addDecision(`Marktregime '${market.szenarioText}'`, "Bestimmt die Basis-Anpassung der Flex-Rate.", "inactive");

            let roheKuerzungProzent = 0;
            kuerzungQuelle = "Profil";
            if (market?.sKey === "bear_deep") {
                roheKuerzungProzent = 50 + Math.max(0, market.abstandVomAthProzent - 20);
                kuerzungQuelle = "Tiefer Bär";
            }
            
            const roheFlexRate = 100 - roheKuerzungProzent;
            let prevFlexRate = lastState?.flexRate ?? 100;
            
            geglätteteFlexRate = AP.FLEX_RATE_SMOOTHING_ALPHA * roheFlexRate + (1 - AP.FLEX_RATE_SMOOTHING_ALPHA) * prevFlexRate;
            
            const delta = geglätteteFlexRate - prevFlexRate;
            let maxUp = AP.RATE_CHANGE_MAX_UP_PP;
            if (currentRegimeRank > lastRegimeRank && runwayMonths >= 36) maxUp = Math.max(maxUp, 10.0);
            else if (regime === 'peak' || regime === 'hot_neutral' || regime === 'recovery_in_bear') maxUp = AP.RATE_CHANGE_AGILE_UP_PP;
            
            const MAX_DOWN = (market.sKey === 'bear_deep') ? 10.0 : AP.RATE_CHANGE_MAX_DOWN_PP;
            
            if (delta > maxUp) { geglätteteFlexRate = prevFlexRate + maxUp; kuerzungQuelle = "Glättung (Anstieg)"; }
            else if (delta < -MAX_DOWN) { geglätteteFlexRate = prevFlexRate - MAX_DOWN; kuerzungQuelle = "Glättung (Abfall)"; }
            
            if (kuerzungQuelle.startsWith("Glättung")) {
                 addDecision("Glättung der Rate", `Veränderung auf max. ${delta > 0 ? maxUp : MAX_DOWN} pp begrenzt. Neue Rate: ${geglätteteFlexRate.toFixed(1)}%`, "active");
            }
            
            let recoveryMaxFlexRate = 100;
            if (market.sKey === 'recovery_in_bear') {
                const gap = Math.max(0, market.abstandVomAthProzent || 0);
                let curb = 10;
                if (gap > 10 && gap <= 15) curb = 15;
                else if (gap > 15 && gap <= 25) curb = 20;
                else if (gap > 25) curb = 25;
                if (runwayMonths < 30) curb = Math.max(curb, 20);
                const maxFlexRate = 100 - curb;
                
                recoveryMaxFlexRate = maxFlexRate;
                if (geglätteteFlexRate > maxFlexRate) {
                    geglätteteFlexRate = maxFlexRate;
                    kuerzungQuelle = "Guardrail (Vorsicht/Recovery)";
                    addDecision("Guardrail (Vorsicht/Recovery)", `Trotz Erholung wird Flex-Rate auf ${maxFlexRate.toFixed(1)}% gekappt (ATH-Abstand: ${gap.toFixed(1)}%).`, "active", "guardrail");
                }
            }

            let angepasstesMinBudget = lastState.lastTotalBudget;
            let inflationCap = inputsCtx.marketData.inflation;
            if (entnahmequoteDepot > VORSICHT_QUOTE) {
                inflationCap = Math.min(inputsCtx.marketData.inflation, 3);
                kuerzungQuelle = "Guardrail (Vorsicht)";
                addDecision("Guardrail (Vorsicht)", `Entnahmequote > ${VORSICHT_QUOTE*100}%. Inflationsanpassung auf max. 3% begrenzt.`, "active", "guardrail");
            }
            angepasstesMinBudget *= (1 + inflationCap / 100);

            const geplanteJahresentnahme = inflatedFloor + (inflatedFlex * (Math.max(0, Math.min(100, geglätteteFlexRate)) / 100));
            const pensionAnnual = inputsCtx?.pensionAnnual ?? 0;
            const aktuellesGesamtbudget = geplanteJahresentnahme + pensionAnnual;

            const budgetFloorErlaubt = (market.sKey !== 'recovery_in_bear') || ((market.abstandVomAthProzent || 0) <= 10 && noNewLowerYearlyCloses && runwayMonths >= Math.max(30, profile.minRunwayMonths + 6));
            if (budgetFloorErlaubt && currentRegimeRank >= lastRegimeRank && aktuellesGesamtbudget + 1 < angepasstesMinBudget) {
                const benötigteJahresentnahme = Math.max(0, angepasstesMinBudget - pensionAnnual);
                const nötigeFlexRate = inflatedFlex > 0 ? Math.min(100, Math.max(0, ((benötigteJahresentnahme - inflatedFloor) / inflatedFlex) * 100)) : 0;

                if (nötigeFlexRate > geglätteteFlexRate) {
                  const limit = (market.sKey === 'recovery_in_bear') ? recoveryMaxFlexRate : 100;
                  geglätteteFlexRate = Math.min(nötigeFlexRate, limit);
                  kuerzungQuelle = (limit < nötigeFlexRate && market.sKey === 'recovery_in_bear') ? "Guardrail (Vorsicht/Recovery)" : "Budget-Floor";
                  addDecision("Budget-Floor", `Um realen Kaufkraftverlust zu vermeiden, wird die Rate auf ${geglätteteFlexRate.toFixed(1)}% angehoben.`, "active", "guardrail");
                }
            }
            endgueltigeEntnahme = inflatedFloor + (inflatedFlex * (Math.max(0, Math.min(100, geglätteteFlexRate)) / 100));
        }

        if (round5) {
            const ungerundeteFlexRate = inflatedFlex > 0 ? ((endgueltigeEntnahme - inflatedFloor) / inflatedFlex * 100) : 0;
            const gerundeteFlexRate = Math.round(ungerundeteFlexRate / 5) * 5;
            if (Math.abs(ungerundeteFlexRate - gerundeteFlexRate) > 0.1) {
                 endgueltigeEntnahme = inflatedFloor + (inflatedFlex * (gerundeteFlexRate / 100));
                 addDecision("Rundung", `Flex-Rate auf nächsten 5%-Schritt gerundet (${gerundeteFlexRate.toFixed(0)}%).`, "inactive");
            }
        }

        const finaleKuerzung = inflatedFlex > 0 ? 100 - (Math.max(0, endgueltigeEntnahme - inflatedFloor) / inflatedFlex * 100) : 0;
        const flexRate = 100 - finaleKuerzung;
        const aktuellesGesamtbudgetFinal = endgueltigeEntnahme + (inputsCtx?.pensionAnnual ?? 0);

        diagnosis.guardrails.push(
            { name: "Entnahmequote", value: entnahmequoteDepot, threshold: ALARM_QUOTE, type: 'percent', rule: 'max' },
            { name: "Realer Drawdown (Gesamt)", value: realerDepotDrawdown, threshold: ALARM_DRAWDOWN, type: 'percent', rule: 'max' },
            { name: "Runway (vs. Min)", value: runwayMonths, threshold: profile.minRunwayMonths, type: 'months', rule: 'min' }
        );

        const cutReasonMap = {
            "Guardrail (Alarm)": "ALARM", "Guardrail (Vorsicht)": "CAUTION", "Guardrail (Vorsicht/Recovery)": "RECOVERY_CAP",
            "Glättung (Anstieg)": "SMOOTHING", "Glättung (Abfall)": "SMOOTHING", "Budget-Floor": "FLOOR_ONLY"
        };
        
        // *** HIER: Inflationsfaktor korrekt fortschreiben ***
        const inflationDieseRunde = inputsCtx?.marketData?.inflation ?? 0;
        const neuerKumulierterFaktor = cumulativeInflationFactor * (1 + inflationDieseRunde / 100);

        const spendingResult = {
          monatlicheEntnahme: endgueltigeEntnahme / 12,
          kuerzungProzent: finaleKuerzung,
          kuerzungQuelle,
          newState: {
              flexRate, lastMarketSKey: market.sKey, lastTotalBudget: aktuellesGesamtbudgetFinal,
              pensionAnnual: (inputsCtx?.pensionAnnual ?? 0), peakRealVermoegen: Math.max(peakRealVermoegen, realVermoegen),
              cumulativeInflationFactor: neuerKumulierterFaktor,
              initialized: true, alarmActive: alarmAktivInDieserRunde || alarmWarAktiv,
              lastInflationAppliedAtAge: lastState.lastInflationAppliedAtAge
          },
          details: {
              geglätteteFlexRate, endgueltigeEntnahme, entnahmequoteDepot, realerDepotDrawdown, flexRate,
              alarmActive: alarmAktivInDieserRunde || alarmWarAktiv,
              regime: market.sKey,
              cutReason: cutReasonMap[kuerzungQuelle] || (finaleKuerzung > 0 ? "PROFILE" : "NONE"),
              quoteStartPct: vorlaeufigeEntnahme / depotValue,
          }
        };

        return { spendingResult, diagnosis };
    },

    calculateTargetLiquidity(profile, market, annualNeed, inflatedFloor, inflatedFlex, wealthYears = Infinity) {
        if (!profile.isDynamic) return (inflatedFloor + inflatedFlex) * 2;
        const regime = this.CONFIG.REGIME_MAP[market.sKey];
        const zielMonate = profile.runway[regime]?.total || profile.runway.hot_neutral.total;

        const useFullFlex = (regime === 'peak' || regime === 'hot_neutral');
        const anpassbarerBedarf = useFullFlex
            ? (inflatedFloor + inflatedFlex)
            : (inflatedFloor + 0.5 * inflatedFlex);

        return (Math.max(1, anpassbarerBedarf) / 12) * zielMonate;
    },

determineAction(results, inputsCtx) {
    /***************************************************************************************************
     * determineAction v3.1 (Konsolidierte Version)
     * -------------------------------------------------------------------------------------------------
     * WARUM: Die vorherige Version hatte Logik-Lücken, die zu "stillen" Liquiditätsänderungen
     *        ohne nachvollziehbares `saleResult` führen konnten. Dies führte zu Inkonsistenzen
     *        in der Balance-App und im Simulator.
     *
     * WAS ÄNDERT SICH:
     *  - EINE FUNKTION: Alle doppelten Definitionen wurden entfernt. Dies ist die einzige Quelle.
     *  - ROBUSTE BEDARFSERMITTLUNG: Klar definierte Logik für Liquiditätsbedarf in Krisen-
     *    vs. Normalphasen.
     *  - GOLD->AKTIEN REBALANCING: Neuer, expliziter Pfad, um Gold-Übergewicht bei ausreichender
     *    Liquidität direkt in Aktien umzuschichten.
     *  - KONSISTENTE VERKÄUFE: Jede Kapitalbeschaffung läuft zwingend über `calculateSaleAndTax`,
     *    das Ergebnis wird im `saleResult` festgehalten.
     *  - SPRECHENDER HANDLUNGSTEXT: Der UI-Text wird dynamisch aus den Verkaufs- und
     *    Kauf-Aktionen generiert, um volle Transparenz zu schaffen.
     *
     * INVARIANTEN (GARANTIEN):
     *  1. Die Signatur und das zurückgegebene Objektformat sind 100% kompatibel mit Simulator V5.
     *  2. `liqNachTransaktion.total` erhöht sich nur dann signifikant, wenn ein `saleResult`
     *     mit einem `achievedRefill > 0` vorliegt. Ein interner Guard-Rail wirft andernfalls
     *     einen Fehler, um stille Inkonsistenzen zu verhindern.
     ***************************************************************************************************/
    const { aktuelleLiquiditaet, depotwertGesamt, zielLiquiditaet, market, grossFloor, spending, minGold } = results;
    const profil = this.CONFIG.PROFIL_MAP[inputsCtx.risikoprofil];

    let actionResult = {
        liqNachTransaktion: { total: aktuelleLiquiditaet, tagesgeld: inputsCtx.tagesgeld, geldmarkt: inputsCtx.geldmarktEtf },
        goldNachTransaktion: inputsCtx.goldWert,
        kaufGold: 0,
        kaufAktien: 0,
        saleResult: null,
        title: "Kein Handlungsbedarf",
        reason: "none",
        liquiditaetsBedarf: 0,
        rebalFlag: false,
        netSaleEquity: 0,
        netSaleGold: 0,
        goldWeightBeforePct: depotwertGesamt > 0 ? (inputsCtx.goldWert / depotwertGesamt) * 100 : 0,
        goldWeightAfterPct: depotwertGesamt > 0 ? (inputsCtx.goldWert / depotwertGesamt) * 100 : 0,
        taxRateSalesPct: 0,
        liquidityGapEUR: zielLiquiditaet - aktuelleLiquiditaet,
        handlungstext: "Alle Puffer im Zielbereich. Keine Umschichtung notwendig.",
        anweisungKlasse: "anweisung-gruen",
        interneHandlungGoldKauf: ""
    };

    // --- 1. BEDARF ERMITTELN ---
    // A) Liquiditätsbedarf
    if (market.sKey === 'bear_deep') {
        const jahresentnahme = spending.monatlicheEntnahme * 12;
        const projizierteEoyLiquiditaet = aktuelleLiquiditaet - jahresentnahme;
        const sicherheitsPuffer = Math.max((grossFloor / 12) * profil.minRunwayMonths, zielLiquiditaet * 0.7);
        if (projizierteEoyLiquiditaet < sicherheitsPuffer) {
            actionResult.liquiditaetsBedarf = Math.ceil((sicherheitsPuffer - projizierteEoyLiquiditaet) / 1000) * 1000;
        }
    } else {
        const isRecovery = market.sKey === 'recovery_in_bear';
        const gap = market.abstandVomAthProzent || 0;
        let angepasstesZiel = zielLiquiditaet * (isRecovery && gap > 10 ? 0.85 : 1.0);
        if (aktuelleLiquiditaet < angepasstesZiel) {
            actionResult.liquiditaetsBedarf = Math.ceil((angepasstesZiel - aktuelleLiquiditaet) / 1000) * 1000;
        }
    }
    const coverage = zielLiquiditaet > 0 ? aktuelleLiquiditaet / zielLiquiditaet : 1;
    if (coverage >= 0.9 && coverage <= 1.1) actionResult.liquiditaetsBedarf = 0;
    if (actionResult.liquiditaetsBedarf > 0 && actionResult.liquiditaetsBedarf < 10000) actionResult.liquiditaetsBedarf = 0;

    // B) Gold Rebalancing-Bedarf
    let goldBedarf = 0, goldUeberschuss = 0;
    const MIN_TRADE = Math.max(10000, 0.005 * depotwertGesamt);

    if (inputsCtx.goldAktiv && depotwertGesamt > 0) {
        const currentWeight = inputsCtx.goldWert / depotwertGesamt;
        const targetWeight = inputsCtx.goldZielProzent / 100;
        const band = inputsCtx.rebalancingBand / 100;
        if (currentWeight < targetWeight * (1 - band)) {
            const fehlbetrag = targetWeight * depotwertGesamt - inputsCtx.goldWert;
            if (fehlbetrag > MIN_TRADE) goldBedarf = fehlbetrag;
        } else if (currentWeight > targetWeight * (1 + band)) {
            const ueberschuss = inputsCtx.goldWert - targetWeight * depotwertGesamt;
            if (ueberschuss > MIN_TRADE) goldUeberschuss = ueberschuss;
        }
    }

    // --- 2. HANDLUNG AUSFÜHREN ---
    const gesamterNettoBedarf = actionResult.liquiditaetsBedarf + goldBedarf;

    if (goldUeberschuss > 0 && actionResult.liquiditaetsBedarf === 0) {
        // Fall A: Gold-Übergewicht in Aktien rebalancen
        actionResult.title = "Strategisches Rebalancing (Gold → Aktien)";
        actionResult.reason = 'rebalance_down';
        actionResult.rebalFlag = true;

        const { saleResult } = this.calculateSaleAndTax(goldUeberschuss, inputsCtx, { minGold, forceKind: 'gold' }, market);
        if (saleResult && saleResult.achievedRefill > 0) {
            actionResult.saleResult = this.mergeSaleResults(actionResult.saleResult, saleResult);
            actionResult.kaufAktien = saleResult.achievedRefill; // Nettoerlös wird für Aktienkauf verwendet
            const bruttoVerkauf = saleResult.breakdown.find(r => r.kind === 'gold')?.brutto || 0;
            actionResult.goldNachTransaktion -= bruttoVerkauf;
        }
    } else if (gesamterNettoBedarf > 0) {
        // Fall B: Liquidität und/oder Gold-Untergewicht aus Depot auffüllen
        actionResult.rebalFlag = true;
        const saleCaps = (market.sKey === 'bear_deep') ? { minGold, forceKind: 'gold' } : { minGold };

        const { saleResult } = this.calculateSaleAndTax(gesamterNettoBedarf, inputsCtx, saleCaps, market);

        if (saleResult && saleResult.achievedRefill > 0) {
            actionResult.saleResult = this.mergeSaleResults(actionResult.saleResult, saleResult);
            const nettoErlös = saleResult.achievedRefill;

            const realerLiqZufluss = Math.min(nettoErlös, actionResult.liquiditaetsBedarf);
            actionResult.liqNachTransaktion.total += realerLiqZufluss;

            const budgetFuerGoldkauf = nettoErlös - realerLiqZufluss;
            actionResult.kaufGold = Math.min(budgetFuerGoldkauf, goldBedarf);
            
            // Restbetrag, der weder für Liquidität noch für Gold gebraucht wurde, bleibt liquide
            const restbetrag = budgetFuerGoldkauf - actionResult.kaufGold;
            actionResult.liqNachTransaktion.total += restbetrag;
            actionResult.interneHandlungGoldKauf = actionResult.kaufGold > 0 ? `Liquidität → Gold: <strong>${window.formatCurrency(actionResult.kaufGold)}</strong>` : "";
        }
    }
    
    // --- 3. ERGEBNISSE FINALISIEREN UND TEXTE ERSTELLEN ---
    if (actionResult.saleResult) {
        actionResult.anweisungKlasse = "anweisung-gelb";
        actionResult.netSaleGold = actionResult.saleResult.breakdown.find(i => i.kind === 'gold')?.brutto || 0;
        actionResult.netSaleEquity = actionResult.saleResult.breakdown.filter(i => i.kind.startsWith('aktien')).reduce((sum, i) => sum + i.brutto, 0);
        actionResult.goldNachTransaktion -= actionResult.netSaleGold;

        // Titel und Grund setzen
        if (actionResult.reason === 'none') {
             if (actionResult.liquiditaetsBedarf > 0 && goldBedarf > 0) { actionResult.title = "Puffer- & Gold-Wiederaufbau"; actionResult.reason = "target_gap"; }
             else if (actionResult.liquiditaetsBedarf > 0) { actionResult.title = "Puffer-Auffüllung"; actionResult.reason = "target_gap"; }
             else if (goldBedarf > 0) { actionResult.title = "Strategisches Rebalancing (Aktien → Gold)"; actionResult.reason = 'rebalance_up'; }
        }

        // Dynamischen Handlungstext bauen
        const uiTextParts = [`<strong style="font-size:1.1em">${actionResult.title}</strong>`];
        const quellen = [];
        if (actionResult.netSaleEquity > 0) quellen.push(`Aktien-ETF: ${window.formatCurrency(actionResult.netSaleEquity)}`);
        if (actionResult.netSaleGold > 0) quellen.push(`Gold: ${window.formatCurrency(actionResult.netSaleGold)}`);
        
        const steuerText = `(inkl. ca. ${window.formatCurrency(actionResult.saleResult.steuerGesamt)} Steuern)`;
        uiTextParts.push(`<strong>Quelle:</strong> ${quellen.join(' + ')} ${steuerText}`);

        const verwendung = [];
        const liqAufgefuellt = actionResult.liqNachTransaktion.total - aktuelleLiquiditaet - (actionResult.kaufGold > 0 ? 0 : (actionResult.saleResult.achievedRefill - actionResult.liquiditaetsBedarf));
        if (liqAufgefuellt > 1) verwendung.push(`Liquiditätspuffer: +${window.formatCurrency(liqAufgefuellt)}`);
        if (actionResult.kaufGold > 0) verwendung.push(`Gold-Kauf: +${window.formatCurrency(actionResult.kaufGold)}`);
        if (actionResult.kaufAktien > 0) verwendung.push(`Aktien-ETF-Kauf: +${window.formatCurrency(actionResult.kaufAktien)}`);
        if (verwendung.length > 0) uiTextParts.push(`<strong>Verwendung:</strong> ${verwendung.join('; ')}`);
        
        actionResult.handlungstext = uiTextParts.join('<br>');
    }
    actionResult.goldNachTransaktion += actionResult.kaufGold;

    const depotWertNachher = depotwertGesamt - (actionResult.saleResult?.bruttoVerkaufGesamt || 0);
    actionResult.goldWeightAfterPct = depotWertNachher > 0 ? (actionResult.goldNachTransaktion / depotWertNachher) * 100 : 0;
    
    if (actionResult.saleResult && actionResult.saleResult.bruttoVerkaufGesamt > 0) {
        actionResult.taxRateSalesPct = (actionResult.saleResult.steuerGesamt / actionResult.saleResult.bruttoVerkaufGesamt) * 100;
    }

    // --- 4. INVARIANTE PRÜFEN ---
    const liqDelta = actionResult.liqNachTransaktion.total - aktuelleLiquiditaet;
    if (liqDelta > 500 && !actionResult.saleResult) {
        throw new Error("determineAction invariant: Liquidity increased without saleResult");
    }

    return actionResult;
},

    calculateSaleAndTax(requestedRefill, inputsCtx, caps = {}, market) {
        let breakdown = [];
        const keSt = 0.25 * (1 + 0.055 + inputsCtx.kirchensteuerSatz);
        let steuerGesamt = 0;
        let bruttoVerkaufGesamt = 0;
        let zuDeckenderBetrag = requestedRefill;
        let verbleibenderPauschbetrag = inputsCtx.sparerPauschbetrag;

        let tranches = {
            aktien_alt: { marketValue: inputsCtx.depotwertAlt, costBasis: inputsCtx.costBasisAlt, tqf: inputsCtx.tqfAlt, kind: 'aktien_alt' },
            aktien_neu: { marketValue: inputsCtx.depotwertNeu, costBasis: inputsCtx.costBasisNeu, tqf: inputsCtx.tqfNeu, kind: 'aktien_neu' },
            gold: inputsCtx.goldAktiv && inputsCtx.goldWert > 0 
                ? { marketValue: inputsCtx.goldWert, costBasis: inputsCtx.goldCost, tqf: inputsCtx.goldSteuerfrei ? 1.0 : 0.0, kind: 'gold' }
                : null
        };
        Object.keys(tranches).forEach(key => {
            if (!tranches[key] || tranches[key].marketValue <= 0) delete tranches[key];
        });

        const equityKeys = Object.keys(tranches).filter(k => k.startsWith('aktien'));
        equityKeys.sort((a, b) => {
            const tA = tranches[a], tB = tranches[b];
            const gqA = tA.marketValue > 0 ? Math.max(0, (tA.marketValue - tA.costBasis) / tA.marketValue) : 0;
            const gqB = tB.marketValue > 0 ? Math.max(0, (tB.marketValue - tB.costBasis) / tB.marketValue) : 0;
            return (gqA * (1 - tA.tqf)) - (gqB * (1 - tB.tqf)); 
        });
        
        const regimeKey = market?.sKey || 'bear_deep';
        let sellOrder;
        const depotwertGesamt = (inputsCtx.depotwertAlt || 0) + (inputsCtx.depotwertNeu || 0) + (inputsCtx.goldWert || 0);
        
        if (inputsCtx.goldAktiv && depotwertGesamt > 0) {
            const currentWeight = inputsCtx.goldWert / depotwertGesamt;
            const targetWeight = inputsCtx.goldZielProzent / 100;
            const rebalancingBandProzent = inputsCtx.rebalancingBand / 100;
            const upperBand = targetWeight * (1 + rebalancingBandProzent);

            if (regimeKey === 'bear_deep') {
                sellOrder = ['gold', ...equityKeys];
            } else if (regimeKey === 'recovery_in_bear' && currentWeight > upperBand) {
                sellOrder = ['gold', ...equityKeys];
            } else if ((regimeKey === 'peak_hot' || regimeKey === 'peak_stable' || regimeKey === 'side_long') && currentWeight > upperBand) {
                sellOrder = ['gold', ...equityKeys];
            } else {
                sellOrder = [...equityKeys, 'gold'];
            }
        } else {
            sellOrder = equityKeys;
        }
        sellOrder = sellOrder.filter(key => tranches[key]);

        if (caps.forceKind) {
            sellOrder = sellOrder.filter(k => k === caps.forceKind);
        }

        for (const kind of sellOrder) {
            if (zuDeckenderBetrag <= 0.01) break;
            const tranche = tranches[kind];
            
            let maxVerkaufbar = tranche.marketValue;
            if (tranche.kind === 'gold' && caps.minGold !== undefined) {
                maxVerkaufbar = Math.min(maxVerkaufbar, Math.max(0, inputsCtx.goldWert - caps.minGold));
            }
            if (maxVerkaufbar <= 0) continue;

            tranche.gewinnQuote = tranche.marketValue > 0 ? Math.max(0, (tranche.marketValue - tranche.costBasis) / tranche.marketValue) : 0;
            const taxDrag = tranche.gewinnQuote * (1 - tranche.tqf) * keSt;
            const taxFactor = 1 - taxDrag;
            const bruttoBenoetigt = taxFactor > 0.01 ? zuDeckenderBetrag / taxFactor : zuDeckenderBetrag * 1.5;
            const zuVerkaufen = Math.min(maxVerkaufbar, bruttoBenoetigt);

            if (zuVerkaufen < 1) continue;

            const gewinnBrutto = zuVerkaufen * tranche.gewinnQuote;
            const zuVersteuernderGewinnBasis = gewinnBrutto * (1 - tranche.tqf);
            const anrechenbarerPauschbetrag = Math.min(verbleibenderPauschbetrag, zuVersteuernderGewinnBasis);
            const steuer = Math.max(0, zuVersteuernderGewinnBasis - anrechenbarerPauschbetrag) * keSt;
            
            const nettoErlös = zuVerkaufen - steuer;
            bruttoVerkaufGesamt += zuVerkaufen;
            steuerGesamt += steuer;
            verbleibenderPauschbetrag -= anrechenbarerPauschbetrag;
            zuDeckenderBetrag -= nettoErlös;
            
            const existingBreakdownItem = breakdown.find(item => item.kind === tranche.kind);
            if (existingBreakdownItem) {
                existingBreakdownItem.brutto += zuVerkaufen;
                existingBreakdownItem.steuer += steuer;
            } else {
                breakdown.push({ kind: tranche.kind, brutto: zuVerkaufen, steuer });
            }
        }
        
        const achievedRefill = Math.max(0, bruttoVerkaufGesamt - steuerGesamt);
        const pauschbetragVerbraucht = inputsCtx.sparerPauschbetrag - verbleibenderPauschbetrag;
        return { saleResult: { steuerGesamt, bruttoVerkaufGesamt, achievedRefill, breakdown, pauschbetragVerbraucht } };
    },

    mergeSaleResults(res1, res2) {
        if (!res1) return res2;
        if (!res2) return res1;

        const merged = {
            steuerGesamt: res1.steuerGesamt + res2.steuerGesamt,
            bruttoVerkaufGesamt: res1.bruttoVerkaufGesamt + res2.bruttoVerkaufGesamt,
            achievedRefill: res1.achievedRefill + res2.achievedRefill,
            pauschbetragVerbraucht: (res1.pauschbetragVerbraucht || 0) + (res2.pauschbetragVerbraucht || 0),
            breakdown: [...res1.breakdown]
        };

        res2.breakdown.forEach(item2 => {
            const existingItem = merged.breakdown.find(item1 => item1.kind === item2.kind);
            if (existingItem) {
                existingItem.brutto += item2.brutto;
                existingItem.steuer += item2.steuer;
            } else {
                merged.breakdown.push({ ...item2 });
            }
        });

        return merged;
    },

    _selfTestExposeFields() {
        console.log("--- Starte Engine Selbsttest für neue Felder ---");
        try {
            const mockSpendingInput = { market: {sKey: 'bear_deep'}, lastState: null, inflatedFloor: 30000, inflatedFlex: 20000, round5: false, runwayMonths: 18, liquidNow: 40000, profile: this.CONFIG.PROFIL_MAP['sicherheits-dynamisch'], depotValue: 500000, inputsCtx: { marketData: { inflation: 2, endeVJ: 800, endeVJ_1: 1000, endeVJ_2: 900 } }, totalWealth: 540000 };
            const { spendingResult } = this.determineSpending(mockSpendingInput);
            const spendingDetails = spendingResult.details;
            const requiredSpendingKeys = ['alarmActive', 'regime', 'cutReason', 'quoteStartPct', 'flexRate'];
            requiredSpendingKeys.forEach(k => { if (!(k in spendingDetails)) console.warn(`Selbsttest FEHLER: Feld '${k}' fehlt in spendingResult.details!`); });

            const mockActionInput = { aktuelleLiquiditaet: 40000, depotwertGesamt: 500000, zielLiquiditaet: 80000, market: {sKey: 'recovery_in_bear'}, grossFloor: 30000, spending: {monatlicheEntnahme: 4000}, minGold: 15000 };
            const mockInputsCtx = { risikoprofil: 'sicherheits-dynamisch', tagesgeld: 40000, geldmarktEtf: 0, goldWert: 25000, goldZielProzent: 5, rebalancingBand: 35, depotwertAlt: 200000, depotwertNeu: 275000, sparerPauschbetrag: 1000 };
            const actionResult = this.determineAction(mockActionInput, mockInputsCtx);
            const requiredActionKeys = ['rebalFlag', 'netSaleEquity', 'netSaleGold', 'goldWeightBeforePct', 'goldWeightAfterPct', 'taxRateSalesPct', 'liquidityGapEUR'];
            requiredActionKeys.forEach(k => { if (!(k in actionResult)) console.warn(`Selbsttest FEHLER: Feld '${k}' fehlt in actionResult!`); });
            
            console.log("--- Engine Selbsttest abgeschlossen. ---");
            return { spendingDetails, actionResult };
        } catch (e) {
            console.error("Schwerer Fehler im Engine Selbsttest:", e);
        }
    }
};
