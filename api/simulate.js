const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

function poissonPMF(l,k){if(k<0||l<=0)return k===0?1:0;let lp=-l+k*Math.log(l);for(let i=1;i<=k;i++)lp-=Math.log(i);return Math.exp(lp);}
function dcTau(x,y,mA,mB){const r=-0.08;if(x===0&&y===0)return 1-mA*mB*r;if(x===0&&y===1)return 1+mA*r;if(x===1&&y===0)return 1+mB*r;if(x===1&&y===1)return 1-r;return 1;}
function dcMatrix(mA,mB){const m=[];for(let i=0;i<=7;i++){m[i]=[];for(let j=0;j<=7;j++)m[i][j]=dcTau(i,j,mA,mB)*poissonPMF(mA,i)*poissonPMF(mB,j);}let t=0;for(let i=0;i<=7;i++)for(let j=0;j<=7;j++)t+=m[i][j];for(let i=0;i<=7;i++)for(let j=0;j<=7;j++)m[i][j]/=t;return m;}
function sampleMat(mat){let r=Math.random(),c=0;for(let i=0;i<mat.length;i++)for(let j=0;j<mat[i].length;j++){c+=mat[i][j];if(r<c)return{ga:i,gb:j};}return{ga:1,gb:1};}
function eloProbs(eA,eB){const pW=1/(1+Math.pow(10,(eB-eA+50)/400));const pD=Math.max(0.10,Math.min(0.30,0.22+0.10*(1-Math.abs(pW-0.5)*2.2)));return{win:+pW.toFixed(4),draw:+pD.toFixed(4),lose:+Math.max(0,1-pW-pD).toFixed(4)};}
function pSample(l){if(l<=0)return 0;let L=Math.exp(-l),k=0,p=1;do{k++;p*=Math.random();}while(p>L&&k<25);return k-1;}
function simCorners(ta,tb){const pfA=Math.max(0.85,1-ta.ppda/30),pfB=Math.max(0.85,1-tb.ppda/30);const c1a=pSample(Math.max(0.2,(ta.possession_avg/100)*5.0*pfA)),c2a=pSample(Math.max(0.2,(ta.possession_avg/100)*4.5*pfA)),c1b=pSample(Math.max(0.2,(tb.possession_avg/100)*4.5*pfB)),c2b=pSample(Math.max(0.2,(tb.possession_avg/100)*5.0*pfB));return{c1a,c2a,cta:c1a+c2a,c1b,c2b,ctb:c1b+c2b,total:c1a+c2a+c1b+c2b};}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { teamA, teamB, context = {} } = req.body;
    if (!teamA || !teamB) return res.status(400).json({ error: 'Faltan equipos' });
    if (teamA === teamB) return res.status(400).json({ error: 'Los equipos deben ser diferentes' });

    const { rows } = await pool.query(`
      SELECT 
        t.name, t.elo, t.fifa_rank, t.flag, t.confederation,
        t.xg_avg, t.xga_avg, t.ppda, t.possession_avg,
        t.shots_avg, t.set_piece_xg, t.star_player, t.wc_appearances,
        t.recent_form,
        COALESCE(t.bayes_att, 0) AS bayes_att,
        COALESCE(t.bayes_def, 0) AS bayes_def,
        COALESCE(t.bayes_net, 0) AS bayes_net,
        COALESCE(t.tactical_ratio, 1.0) AS tactical_ratio,
        COALESCE(ts.xg_last_5, t.xg_avg) AS xg_recent,
        COALESCE(ts.goals_scored, 0) AS goals_scored,
        COALESCE(ts.points, 0) AS points,
        COALESCE(ts.matchday, 0) AS matchday,
        ts.xg_match1, ts.xg_match2, ts.xg_match3, ts.xg_match4,
        COALESCE(ph.wins, 1) AS pen_wins,
        COALESCE(ph.losses, 1) AS pen_losses
      FROM teams t 
      LEFT JOIN team_tournament_stats ts ON ts.team_name = t.name
      LEFT JOIN penalty_history ph ON ph.team_name = t.name
      WHERE LOWER(t.name) IN (LOWER($1), LOWER($2))
    `, [teamA, teamB]);

    const ta = rows.find(r => r.name.toLowerCase() === teamA.toLowerCase());
    const tb = rows.find(r => r.name.toLowerCase() === teamB.toLowerCase());
    if (!ta) return res.status(404).json({ error: `Equipo no encontrado: ${teamA}` });
    if (!tb) return res.status(404).json({ error: `Equipo no encontrado: ${teamB}` });

    const ctx = (context.weather||1)*(context.phase||1)*(context.rest||1);

    // Elo dinámico
    const K = 60;
    const matchesA = parseInt(ta.matchday) || 0;
    const matchesB = parseInt(tb.matchday) || 0;
    const winRateA = matchesA > 0 ? ta.points / (matchesA * 3) : 0.5;
    const winRateB = matchesB > 0 ? tb.points / (matchesB * 3) : 0.5;
    const expectedA = 1 / (1 + Math.pow(10, (tb.elo - ta.elo) / 400));
    const eloAdjA = Math.round(K * matchesA * (winRateA - expectedA));
    const eloAdjB = Math.round(K * matchesB * (winRateB - expectedA));
    const elo_a = ta.elo + eloAdjA;
    const elo_b = tb.elo + eloAdjB;
    const eloP = eloProbs(elo_a, elo_b);

    // Forma reciente ponderada
    function weightedXG(t) {
      const m = parseInt(t.matchday) || 0;
      const m1 = parseFloat(t.xg_match1 || 0);
      const m2 = parseFloat(t.xg_match2 || 0);
      const m3 = parseFloat(t.xg_match3 || 0);
      const m4 = parseFloat(t.xg_match4 || 0);
      if (m >= 4) return (m1*0.10 + m2*0.20 + m3*0.30 + m4*0.40);
      if (m === 3) return (m1*0.20 + m2*0.35 + m3*0.45);
      if (m === 2) return (m1*0.40 + m2*0.60);
      return parseFloat(t.xg_recent || t.xg_avg || 1.2);
    }

    const ef = Math.max(-0.8, Math.min(0.8, (elo_a - elo_b) / 600));
    const xg_a = Math.max(0.3, weightedXG(ta));
    const xg_b = Math.max(0.3, weightedXG(tb));
    const xgDef_a = parseFloat(tb.xga_avg || 1.2);
    const xgDef_b = parseFloat(ta.xga_avg || 1.2);
    const pts_a = parseFloat(ta.points || 0);
    const pts_b = parseFloat(tb.points || 0);

    // Fuerzas Bayesianas
    const bayes_att_a = parseFloat(ta.bayes_att || 0);
    const bayes_def_a = parseFloat(ta.bayes_def || 0);
    const bayes_att_b = parseFloat(tb.bayes_att || 0);
    const bayes_def_b = parseFloat(tb.bayes_def || 0);

    // Índice táctico
    // Índice táctico suavizado — peso reducido para no distorsionar
const tact_raw_a = parseFloat(ta.tactical_ratio || 1.0);
const tact_raw_b = parseFloat(tb.tactical_ratio || 1.0);
const tact_a = Math.max(0.85, Math.min(1.15, 0.7 + tact_raw_a * 0.3));
const tact_b = Math.max(0.85, Math.min(1.15, 0.7 + tact_raw_b * 0.3));

    // Lambda combinado: 40% Bayesiano + 60% modelo actual + ajuste táctico
    let raw_a = Math.max(0.3,
      (0.60 * ((xg_a * 0.45) + (xgDef_a * 0.20) + (ef * 0.20) + (pts_a * 0.04)) +
      0.40 * Math.exp(0.3 + 0.1 + bayes_att_a - bayes_def_b)) * tact_a
    );
    let raw_b = Math.max(0.3,
      (0.60 * ((xg_b * 0.45) + (xgDef_b * 0.20) - (ef * 0.20) + (pts_b * 0.04)) +
      0.40 * Math.exp(0.3 + bayes_att_b - bayes_def_a)) * tact_b
    );

    const total_raw = raw_a + raw_b;
    const phase = parseFloat(context.phase || 1);
    const TARGET = phase >= 1.15 ? 2.35 : phase >= 1.09 ? 2.45 : phase >= 1.05 ? 2.52 : 2.60;
    const muA = Math.max(0.4, parseFloat((raw_a / total_raw * TARGET * ctx).toFixed(3)));
    const muB = Math.max(0.35, parseFloat((raw_b / total_raw * TARGET * ctx).toFixed(3)));

    const matrix = dcMatrix(muA, muB);
    const {ga, gb} = sampleMat(matrix);
    const corners = simCorners(ta, tb);
    const rand=(a,b)=>Math.floor(Math.random()*(b-a+1))+a;
    const ev=[];
    const pA=[ta.star_player,'Delantero','Mediocampista','Extremo','Defensa SP'];
    const pB=[tb.star_player,'Delantero','Mediocampista','Extremo','Defensa SP'];
    for(let i=0;i<ga;i++){const sp=Math.random()<(ta.set_piece_xg/((ta.xg_avg*1.4)||1))*.5,ph=Math.random(),m=ph<.22?rand(3,22):ph<.52?rand(23,55):ph<.78?rand(56,78):rand(79,95);ev.push({min:m,team:'a',type:sp?'setpiece':'goal',player:pA[i%pA.length]});}
    for(let i=0;i<gb;i++){const sp=Math.random()<(tb.set_piece_xg/((tb.xg_avg*1.4)||1))*.5,ph=Math.random(),m=ph<.18?rand(8,25):ph<.48?rand(26,58):ph<.76?rand(59,82):rand(83,96);ev.push({min:m,team:'b',type:sp?'setpiece':'goal',player:pB[i%pB.length]});}
    ev.sort((a,b)=>a.min-b.min);
    const eloRatio=ta.elo/(ta.elo+tb.elo);
    const possA=Math.round(Math.max(28,Math.min(72,ta.possession_avg*(0.92+eloRatio*0.16))));

    // Lógica eliminatoria con historial de penales
    let finalGa = ga, finalGb = gb;
    let extraTime = false, penalties = false, penaltyWinner = null;
    const isKnockout = phase >= 1.05;

    if (isKnockout && ga === gb) {
      extraTime = true;
      const etMuA = muA * 0.6;
      const etMuB = muB * 0.6;
      const etMat = dcMatrix(etMuA, etMuB);
      const et = sampleMat(etMat);
      finalGa += et.ga;
      finalGb += et.gb;

      if (finalGa === finalGb) {
        penalties = true;
        const penRateA = (parseFloat(ta.pen_wins) + 1.5) / (parseFloat(ta.pen_wins) + parseFloat(ta.pen_losses) + 3);
        const penRateB = (parseFloat(tb.pen_wins) + 1.5) / (parseFloat(tb.pen_wins) + parseFloat(tb.pen_losses) + 3);
        const penProbA = penRateA / (penRateA + penRateB);
        penaltyWinner = Math.random() < penProbA ? 'a' : 'b';
      }
    }

    // Guardar en historial
    try {
      await pool.query(`
        INSERT INTO simulation_history 
        (team_a, team_b, goals_a, goals_b, mu_a, mu_b, phase, extra_time, penalties, penalty_winner, model_used, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'bayes-dc-tact-v1', NOW())
      `, [teamA, teamB, finalGa, finalGb, muA, muB, context.phase||1, extraTime, penalties, penaltyWinner]);
    } catch(e) { console.error('History error:', e.message); }

    res.status(200).json({
      result:{
        ga: finalGa, gb: finalGb,
        extraTime, penalties, penaltyWinner,
        winner: finalGa > finalGb ? 'a' : finalGb > finalGa ? 'b' : penaltyWinner
      },
      teams:{a:{name:teamA,flag:ta.flag,elo:ta.elo,rank:ta.fifa_rank},b:{name:teamB,flag:tb.flag,elo:tb.elo,rank:tb.fifa_rank}},
      penHistory:{a:{wins:parseInt(ta.pen_wins),losses:parseInt(ta.pen_losses)},b:{wins:parseInt(tb.pen_wins),losses:parseInt(tb.pen_losses)}},
      model:{muA,muB,expectedGoals:+(muA+muB).toFixed(2),eloProbs:eloP},
      matrix:matrix.slice(0,5).map(r=>r.slice(0,5)),
      corners, events:ev,
      stats:{
        possession:{a:possA,b:100-possA},
        shots:{a:Math.max(3,Math.round(ta.shots_avg*(.85+Math.random()*.3)+ga*1.5)),b:Math.max(3,Math.round(tb.shots_avg*(.85+Math.random()*.3)+gb*1.5))},
        xg:{a:+muA.toFixed(2),b:+muB.toFixed(2)},
        ppda:{a:+(ta.ppda*(.92+Math.random()*.16)).toFixed(1),b:+(tb.ppda*(.92+Math.random()*.16)).toFixed(1)},
        setpieceXg:{a:+(ta.set_piece_xg*(.85+Math.random()*.3)).toFixed(2),b:+(tb.set_piece_xg*(.85+Math.random()*.3)).toFixed(2)}
      },
    });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno', detail: err.message });
  }
};