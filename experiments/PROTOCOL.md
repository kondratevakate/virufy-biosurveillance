# Experiment protocol (frozen 2026-11-18, before any of E1 to E3 was run)

Model used throughout (as in the paper draft): for site s and interval t, the true cough
count is Poisson with mean E * b * r, where E is the load in person-hours, b the background
cough rate per person-hour and r the outbreak factor (r = 1 without an outbreak, r >= 1 + kappa
during one). The phone detector thins and contaminates this stream: the observed count is

    Y ~ Poisson( E * (s * b * r + phi) )

with s the detector sensitivity and phi its false-alarm rate per listening hour.

## E1. Detections per hour in real public-space audio

- Question: how often does the deployed detector fire in public places where nobody was asked to cough?
- Data: TAU Urban Acoustic Scenes 2019, development set (Zenodo 2589280), archives audio.1 and
  audio.2 as downloaded; all clips in them, no selection. 10-second clips, 10 scene types.
- Detector: the app's model file and rule: one score per 0.975 s window, an event when the
  "Cough" score is at least 0.5 (the app threshold, fixed on 2026-11-16).
- Outcome: events per hour of audio, overall and per scene, with exact Poisson 95% intervals;
  the same at thresholds 0.3 and 0.7 as sensitivity analysis.
- Reading: the recordings contain unlabelled real coughs, so the number is an upper bound on the
  false-alarm rate phi, not phi itself. No listening or relabelling is done.

## E2. Detection delay as a function of load and detector error (simulation)

- Question: for a fixed false-alarm budget, how many days does it take to detect an outbreak of
  size kappa, and how do crowd size E and the detector's false alarms phi change that?
- Parameters taken from data: s = 0.825 (ESC-50, threshold 0.5); phi = the overall E1 rate and
  the highest per-scene E1 rate. Assumed, and labelled as assumed: b in {0.5, 2} coughs per
  person-hour; day-of-week factors (1.0 weekdays, 0.8 weekend); daily load noise lognormal, sd 0.2.
- Grid: E in {50, 200, 1000, 5000} person-hours per day; kappa in {0.1, 0.2, 0.5, 1.0};
  phi in {0, E1 overall, E1 worst scene}.
- Detectors: (a) Poisson CUSUM with load offset, designed for kappa = 0.5, baseline rate estimated
  from an 8-week burn-in; (b) the prototype's median/MAD rule on the rate Y/E (8-day window,
  z > threshold); (c) EARS C2-style rule (7-day mean and sd, 2-day guard).
- Calibration: each detector's threshold is set by simulation so that the in-control average run
  length (ARL0) is 180 days. Then: average detection delay (ADD) in days and the probability of
  detection within 7 and 14 days, 2000 runs per cell, outbreak starting 30 days after burn-in.
- Theory check: CUSUM delay against the first-order approximation ln(ARL0) / I, with
  I = mu1 * ln(mu1 / mu0) - (mu1 - mu0) the per-day Kullback-Leibler information, mu0 = E (s b + phi),
  mu1 = E (s b (1 + kappa) + phi).
- Robustness (assumed, not from data): negative binomial counts with dispersion size 10.
- Hypotheses: H1 CUSUM has the shortest delay at equal ARL0 for every cell; H2 delay falls roughly
  as 1/E; H3 false alarms phi lengthen the delay by the factor predicted by I.
- Not claimed: anything about real outbreaks. All counts are simulated.

## E3. Aviation wastewater against national clinical positivity (real data, exploratory)

- Question: does the US aviation wastewater positivity series move before, with or after the
  national clinical percent-positive series for the same pathogen?
- Data: Zenodo 18432347 (US file), weekly share of positive samples by MMWR week (week ending
  Saturday); CDC "Percent of Tests Positive for Viral Respiratory Pathogens" (data.cdc.gov
  seuz-s2cv), national weekly values. Pairs: SARS-CoV-2 with COVID-19; Influenza A with Influenza
  (primary), Influenza B with Influenza (secondary); RSV with RSV.
- Outcome: Spearman correlation at lags -6 to +6 weeks; the lag with the highest correlation
  (positive = wastewater leads); 95% interval for that lag from a moving-block bootstrap
  (block 4 weeks, 2000 resamples). Weeks with fewer than 3 wastewater samples are dropped.
- Reading: one season, about 40 weeks, aircraft from many origins against US clinical tests.
  A lag here is descriptive; it is not a validated lead time.

## Amendment 1 (2026-11-18, before any E1 result beyond a 40-clip timing run with 0 events)

The archives are sorted by scene: audio.1 holds only airport clips (694), so audio.1 and audio.2
would give one scene and no "worst scene" rate for E2. Added before running E1: archives audio.7
and audio.13, chosen by number only, to cover other indoor public places. All clips of the four
archives are scored; scenes are reported as found. Everything else in E1 and E2 is unchanged.

## Amendment 2 (2026-11-18, after E1, before E2)

E1 gave 0 detections in 7.71 h (2,776 clips; airport, metro, metro station, public square,
shopping mall) at all three thresholds; the highest cough score was 0.11. So the planned E2 values
"E1 overall" and "E1 worst scene" are both 0. E2 therefore uses phi in {0, 0.48, 3.3} per listening
hour: 0.48 is the upper 95% bound from E1, and 3.3 is the rate on ESC-50 non-cough clips at the app
threshold (a deliberately hard mix of sounds). E1 also means the detector did not pick up the coughs
that 7.7 hours of crowded places must contain, so sensitivity for distant coughs is unknown and
probably low. E2 is therefore run for s = 0.825 (ESC-50, close recordings) and for s = 0.2
(assumed, to show the effect of a large loss); s = 0.2 is not a measurement.

## Amendment 3 (2026-11-18, after the first E2 run; exploratory)

First E2 run (kept in results/e2_v1): H1 failed. The CUSUM designed for a ratio of 1.5 was fastest
in 108 of 192 cells and never alarmed in others. Reason, known for CUSUM charts: its drift under a
true total-rate ratio rho is mu0 * (rho * ln 1.5 - 0.5), negative for rho < 1.233, and the effective
ratio is rho = 1 + kappa * s b / (s b + phi), so small rises, low sensitivity or many false alarms push
it below that value. Added after seeing this, and therefore exploratory: detector (d), a bank of
CUSUMs with design ratios 1.05, 1.1, 1.2, 1.5 and 2.0; each is scaled by its own alarm level for
ARL0 = 180 days, the statistic is the largest scaled value, and the bank is then calibrated to
ARL0 = 180 days as a whole. The grid, seeds and other detectors are unchanged; the run is repeated in full.
