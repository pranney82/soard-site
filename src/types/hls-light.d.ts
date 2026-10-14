// hls.js ships no types for its "light" entry point; it is the same class as the full build
declare module 'hls.js/light' {
  import Hls from 'hls.js';
  export default Hls;
}
