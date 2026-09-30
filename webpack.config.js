import path from "path";
import { fileURLToPath } from "url";
import MiniCssExtractPlugin from "mini-css-extract-plugin";
import CssMinimizerPlugin from "css-minimizer-webpack-plugin";
import HtmlWebpackPlugin from "html-webpack-plugin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The hash of a file's own content, in its name.
//
// This one line is what makes the two servers below agree about caching: the
// PHP router sends a year-long immutable cache for /dist/, and nginx sends the
// same, and both are correct BECAUSE the name changes whenever the bytes do. A
// rebuilt fix therefore reaches a client that already has the old release
// without anyone pressing Ctrl+F5, and neither server has to be clever about
// revalidation.
//
// `8` hex characters is 32 bits of a hash nobody is attacking, and it keeps the
// name short enough to read in a server log.
const HASH = "[contenthash:8]";

export default {
    mode: "production",
    target: ["web", "es2020"],
    entry: {
        app: [
            "./app/js/main.js",
            "./app/css/tokens.css",
            "./app/css/base.css",
            "./app/css/layout.css",
            "./app/css/components.css"
        ]
    },
    output: {
        path: path.resolve(__dirname, "app/dist"),
        filename: `app.${HASH}.js`,
        clean: true,
        publicPath: "/dist/"
    },
    module: {
        rules: [
            {
                test: /\.css$/,
                use: [MiniCssExtractPlugin.loader, "css-loader"]
            },
            {
                test: /\.s[ac]ss$/i,
                use: [MiniCssExtractPlugin.loader, "css-loader", "sass-loader"]
            }
        ]
    },
    optimization: {
        // Off because the service worker and the "one bundle, offline for a
        // week" deployment read better as one unit than as twenty.
        concatenateModules: false,
        minimize: true,
        // `...` is webpack's own Terser pass, kept in the list: naming a
        // minimizer does not replace the default one, it prepends to it. The
        // stylesheet is what needed adding — `minimize: true` alone only ever
        // touched the JavaScript, which is why the extracted CSS shipped with
        // every comment in it.
        minimizer: ["...", new CssMinimizerPlugin()]
    },
    plugins: [
        new MiniCssExtractPlugin({ filename: `app.${HASH}.css` }),
        // The shell is BUILT, not hand-maintained. `app/index.html` is the
        // template and carries no asset URLs at all; this fills in the hashed
        // names and writes the served page to app/dist/index.html, which is the
        // single file the SPA, the service worker and both servers use. So the
        // HTML cannot name an asset that this build did not produce, and there
        // is no second place to update when a name changes.
        new HtmlWebpackPlugin({
            template: "./app/index.html",
            filename: "index.html",
            scriptLoading: "defer",
            inject: "body",
            minify: {
                collapseWhitespace: true,
                removeComments: true,
                removeRedundantAttributes: true,
                useShortDoctype: true
            }
        })
    ],
    performance: { hints: false }
};
