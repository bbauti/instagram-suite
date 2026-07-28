// Gender guess from names — pure local heuristic, zero network requests.
// Dictionary of common given names (Spanish/Argentine, English, Italian,
// Portuguese, Arabic, Slavic) + the Romance suffix rule (-a female / -o male)
// on the first full-name token, + longest-prefix match on username tokens
// ("juanperez99" → juan). Returns 'f' | 'm' | '' (unidentified).
// ponytail: a guess, not a fact — ambiguous names (alex, sam, jordan, taylor,
// chris, robin, dana, michele, simone, nicola…) are deliberately left out and
// fall through to ''. andrea→f and ariel→m follow Spanish-market usage.
const F = new Set(('maria,ana,anna,lucia,sofia,sophia,valentina,camila,camille,martina,julieta,julia,juliana,'
  + 'agustina,florencia,antonella,victoria,milagros,guadalupe,rocio,belen,abril,malena,magdalena,catalina,'
  + 'delfina,josefina,clara,claire,elena,helena,irene,laura,lara,paula,carla,karla,andrea,daniela,danielle,'
  + 'gabriela,gabriella,mariana,carolina,caroline,carol,carolyn,veronica,silvina,silvia,sylvia,patricia,'
  + 'claudia,sandra,monica,adriana,alejandra,natalia,natalie,nathalie,noelia,romina,vanesa,vanessa,yanina,'
  + 'daiana,dayana,diana,diane,brenda,cintia,cinthia,cynthia,melina,melisa,melissa,marina,celina,celeste,'
  + 'aylen,ailen,ailin,nadia,magali,mariel,marisol,maribel,isabel,isabelle,isabella,ines,raquel,rachel,'
  + 'miriam,myriam,noemi,naomi,ruth,esther,ester,edith,mercedes,dolores,carmen,pilar,soledad,lourdes,leonor,'
  + 'beatriz,beatrice,graciela,susana,susan,suzanne,norma,alicia,alice,elsa,marta,martha,teresa,theresa,rosa,'
  + 'rose,rosario,ramona,juana,francisca,antonia,emilia,emily,amelia,olivia,valeria,valerie,virginia,regina,'
  + 'sabrina,karina,corina,lorena,macarena,ximena,jimena,luciana,viviana,fabiana,liliana,eliana,ariana,'
  + 'arianna,oriana,tatiana,bianca,blanca,micaela,michaela,mikaela,rafaela,manuela,emma,mia,zoe,alma,amanda,'
  + 'samantha,jennifer,jenifer,jenny,jessica,jesica,yesica,karen,kimberly,ashley,brittany,stephanie,'
  + 'estefania,melanie,melany,nicole,nicol,michelle,denise,giselle,gisele,gisela,solange,jazmin,yasmin,'
  + 'jasmine,hannah,hanna,sarah,sara,rebecca,rebeca,elizabeth,elisabeth,lisa,linda,nancy,margaret,margarita,'
  + 'sharon,kathleen,katherine,catherine,kathryn,kathy,katie,kate,katia,christine,cristina,christina,kristen,'
  + 'kirsten,kristin,deborah,debora,barbara,betty,dorothy,donna,evelyn,judith,megan,meghan,cheryl,jacqueline,'
  + 'jaqueline,gloria,janet,janice,joan,joanna,johanna,joyce,julie,grace,amber,doris,marilyn,beverly,natasha,'
  + 'charlotte,marie,kayla,lori,heather,tiffany,courtney,lindsay,lindsey,whitney,chelsea,kelsey,paige,brooke,'
  + 'hailey,hayley,haley,kaitlyn,caitlin,abigail,madison,chloe,ella,lily,lilly,ruby,daisy,ivy,violet,hazel,'
  + 'stella,luna,aurora,alba,candela,ambar,milena,ludmila,priscila,priscilla,pamela,yamila,kiara,chiara,'
  + 'zaira,anahi,araceli,lola,pia,paz,luz,flor,azul,agostina,constanza,renata,ornella,miranda,mora,olga,vera,'
  + 'nina,irina,tamara,erica,erika,paola,fernanda,angeles,angela,angelica,angelina,angie,rosalia,amparo,'
  + 'consuelo,socorro,morena,alfonsina,azucena,aitana,eva,fatima,aisha,yasmina,'
  // Argentine nicknames (incl. -o endings that would trip the suffix rule) + spelling variants
  + 'caro,anto,majo,marce,meri,mery,mirian,antonela,belu,sofi,cande,cata,mica,naty,nati,romi,yami,vale,euge,'
  + 'meli,mili,mile,vero,moni,pauli,pau,viki,vicky,vicki,connie,coni,guada,luli,maru,coty,cami,agos,martu,'
  + 'jime,gime,flopy,aldi').split(','));
const M = new Set(('juan,jose,luis,carlos,jorge,miguel,angel,rafael,raphael,manuel,samuel,daniel,david,gabriel,'
  + 'javier,xavier,jesus,cesar,hector,victor,oscar,ivan,ruben,martin,agustin,joaquin,julian,adrian,fabian,'
  + 'damian,hernan,german,gaston,cristian,christian,sebastian,esteban,emanuel,emmanuel,ezequiel,exequiel,'
  + 'nahuel,lautaro,thiago,tiago,santiago,santino,mateo,matteo,matias,tomas,thomas,tom,lucas,luca,lukas,luka,'
  + 'marcos,marco,mark,marcus,mario,dario,diego,pablo,pedro,paulo,bruno,franco,marcelo,gustavo,eduardo,'
  + 'edward,ricardo,richard,roberto,robert,alberto,albert,ernesto,ernest,augusto,alfredo,alfred,fernando,'
  + 'gonzalo,rodrigo,facundo,ignacio,benjamin,felipe,philip,phillip,felix,andres,andrew,andy,nicolas,'
  + 'nicholas,elias,jonas,isaias,jeremias,jeremiah,ramiro,mauricio,maximiliano,maximo,leandro,lisandro,'
  + 'alejandro,alexander,axel,alan,allan,allen,brian,bryan,kevin,jonathan,johnatan,uriel,ariel,gael,ian,liam,'
  + 'noah,ethan,dylan,aaron,adam,abraham,isaac,jacob,jack,james,john,johnny,jhon,michael,mike,william,'
  + 'charles,christopher,matthew,anthony,antonio,antony,donald,steven,stephen,paul,joshua,kenneth,george,'
  + 'ronald,timothy,jason,jeffrey,jeff,ryan,gary,eric,erik,erick,larry,justin,scott,brandon,frank,francisco,'
  + 'francesco,raymond,ramon,patrick,patricio,dennis,jerry,tyler,austin,carl,carlo,arthur,arturo,lawrence,'
  + 'lorenzo,jesse,bruce,logan,wayne,elijah,vincent,vicente,louis,henry,henrique,enrique,nathan,nathaniel,'
  + 'douglas,zachary,peter,kyle,walter,jeremy,keith,roger,rogelio,gerald,gerardo,harold,sean,shawn,shaun,'
  + 'mason,hunter,connor,caleb,cole,chad,derek,trevor,travis,todd,troy,wesley,ross,dean,glenn,neil,craig,'
  + 'kurt,kirk,lance,dante,enzo,ciro,gino,giovanni,giuseppe,gabriele,daniele,davide,alessandro,leonardo,leo,'
  + 'lionel,valentino,salvador,salvatore,joao,caio,hugo,omar,ahmed,ahmad,mohamed,mohammed,muhammad,'
  + 'mustafa,hassan,hussein,ibrahim,yusuf,karim,khalid,tariq,dmitri,dimitri,sergei,sergio,andrei,nikita,ilya,'
  + 'igor,boris,pavel,vladimir,alexei,aleksei,mikhail,emilio,emiliano,ulises,gregorio,gregory,greg,ismael,'
  + 'moises,abel,joel,simon,elian,bautista,benicio,bastian,iker,jordi,xavi,marc,'
  // Argentine nicknames (incl. -a endings that would trip the suffix rule).
  // 'ali' is NOT here: in this market Ali ≈ Alicia/Alina, not the Arabic name.
  + 'nico,santi,seba,sebas,guille,tomi,nacho,lucho,tincho,maxi,fede,gonza,rodri,mati,joaco,nahue,lauti,facu,'
  + 'pancho,rama,lean,juanma,juampi,edu,gabo').split(','));

// Common Hispanic surnames — used ONLY to validate the username prefix match:
// "juanperez" splits as juan+perez (name + surname → trust it), while
// "hernandez" would otherwise false-match "hernan" with garbage left over.
const SURNAMES = new Set(('gonzalez,rodriguez,fernandez,hernandez,martinez,lopez,garcia,gimenez,jimenez,perez,'
  + 'sanchez,ramirez,torres,flores,rivera,gomez,diaz,morales,ortiz,gutierrez,chavez,ruiz,alvarez,castillo,'
  + 'vasquez,vazquez,moreno,romero,herrera,medina,aguilar,vargas,castro,mendoza,guzman,munoz,salazar,soto,'
  + 'delgado,pena,rios,silva,sosa,rojas,molina,acosta,benitez,juarez,navarro,dominguez,campos,vega,fuentes,'
  + 'leon,cabrera,ponce,marquez,ibarra,escobar,villalba,godoy,ferreyra,ledesma,quiroga,bustos,coronel,paz,'
  + 'luna,suarez,blanco,nunez,ramos,mendez,cardozo,pereyra,aguirre,maldonado,arias,roldan,villegas,correa,'
  + 'ojeda,franco,montes,santos,lucero,rossi,bianchi,romano,ricci,russo').split(','));

// business words ending in -a/-o that would otherwise trip the suffix rule
const STOP = new Set(('estudio,tienda,pizzeria,panaderia,peluqueria,barberia,fotografia,agencia,academia,clinica,'
  + 'estetica,cocina,moda,indumentaria,joyeria,libreria,veterinaria,inmobiliaria,optica,farmacia,ferreteria,'
  + 'carniceria,verduleria,heladeria,pasteleria,cerveceria,parrilla,resto,centro,grupo,equipo,banda,radio,'
  + 'revista,tattoo,studio,photo,video').split(','));

const normalize = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const lookup = (token) => (F.has(token) ? 'f' : M.has(token) ? 'm' : '');
// longest dictionary prefix for glued usernames ("juanperez99" → juan) — the
// remainder must itself be a name/surname (or a single trailing char, "merii"),
// so surnames like hernandez/martinez don't false-match hernan/martin.
const prefixLookup = (token) => {
  for (let i = Math.min(token.length, 12); i >= 4; i--) {
    const hit = lookup(token.slice(0, i));
    if (hit) {
      const rest = token.slice(i);
      if (rest.length <= 1 || F.has(rest) || M.has(rest) || SURNAMES.has(rest)) return hit;
    }
  }
  return '';
};

export const guessGender = (user) => {
  const nameTokens = normalize(user.fullName).match(/[a-z]+/g) || [];
  for (const token of nameTokens.slice(0, 2)) {
    const hit = lookup(token);
    if (hit) return hit;
  }
  const first = nameTokens[0];
  if (first?.length >= 3 && !STOP.has(first)) {
    if (first.endsWith('a')) return 'f';
    if (first.endsWith('o')) return 'm';
  }
  for (const token of normalize(user.username).match(/[a-z]+/g) || []) {
    const hit = lookup(token) || (token.length >= 4 ? prefixLookup(token) : '');
    if (hit) return hit;
  }
  return '';
};
