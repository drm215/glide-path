import { $, pageData, setUpRoundMap } from './lib.js';

const data = pageData();
if (data?.shots) setUpRoundMap($('#map'), data.shots, data.layouts);
