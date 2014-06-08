(function(global) {
  'use strict';

  // @namespace
  var teddy = {


    /**
     * Teddy core methods
     */

    // compiles a template (removes {! comments !} and unnecessary whitespace)
    compile: function(template, name) {
      var fname = '';

      // remove templateRoot from template name if necessary
      if (!name) {
        name = template.replace(teddy.params.templateRoot, '');
      }

      // convert filepath into a template string if we're in node
      if (isNode) {
        try {
          if (fs.existsSync(template)) {
            fname = template;
          }
          else {
            fname = teddy.params.templateRoot + template;
          }

          // attempt readFile
          template = fs.readFileSync(fname, 'utf8');
        }
        catch (e) {
          if (teddy.params.verbosity) {
            console.warn('teddy.compile threw an exception while attempting to compile a template: ' + e);
          }
          return false;
        }
      }

      // it's assumed that the argument is already a template string if we're not in node
      else if ((typeof template).toLowerCase() !== 'string') {
        if (teddy.params.verbosity > 1) {
          console.warn('teddy.compile attempted to compile a template which is not a string.');
        }
        return false;
      }

      // append extension if not present
      if (name.slice(-5) !== '.html') {
        name += '.html';
      }

      // remove {! comments !} and unnecessary whitespace
      teddy.compiledTemplates[name] = template
        .replace(/[\f\n\r\t\v]*/g, '')
        .replace(/{!(.*?)!}/g, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/> </g, '><');

      // write eval'able js ready to send over to the client
      teddy.packagedTemplates[name] = 'teddy.compiledTemplates[\''+name+'\']=\''+teddy.compiledTemplates[name].replace(/'/g, '\\\'')+'\';';
    },

    // parses a template
    render: function(template, model, callback) {

      // needed because sigh
      if (oldIE) {
        console.error('Teddy does not support client-side templating on IE9 or below.');
        return false;
      }

      // handle bad or unsupplied model
      if (!model || (typeof model).toLowerCase() !== 'object') {
        model = {};
      }

      // needed for express.js support
      if (model.settings) {
        if (model.settings.views) {
          teddy.params.templateRoot = path.normalize(model.settings.views);
        }
      }

      // flatten model to produce case-insensitivity (needed because HTML is case-insensitive)
      model = teddy.flattenModel(model);

      // store original copy of model so it can be reset after being temporarily modified
      teddy._baseModel = JSON.parse(JSON.stringify(model));

      // remove templateRoot from template name if necessary
      template = template.replace(teddy.params.templateRoot, '');

      // compile template if necessary
      if (!teddy.compiledTemplates[template] || teddy.params.compileAtEveryRender) {
        teddy.compile(template);
      }

      // append extension if not present
      if (template.slice(-5) !== '.html') {
        template += '.html';
      }

      // declare vars
      var compiledTemplate = teddy.compiledTemplates[template],
          errors, renderedTemplate;

      // create dom object out of template string
      if (compiledTemplate) {

        // some elements have special rules and must be normalized first by temporarily converting them into unknown elements
        compiledTemplate = teddy.temporarilyRenameProblemElements(compiledTemplate);

        renderedTemplate = parser.parseFromString(compiledTemplate, 'text/html');
      }
      else {
        if (teddy.params.verbosity) {
          console.warn('teddy.render attempted to render a template which doesn\'t exist: ' + template);
        }
        return false;
      }

      // this hack is necessary for IE and Opera compatibility
      renderedTemplate = teddy.runUnknownElementParentSiblingHack(renderedTemplate);

      // since includes can introduce new conditionals, we loop until they're all dealt with
      while (teddy.findNonLoopedConditionals(renderedTemplate)[0] || teddy.findNonLoopedOneLineConditionals(renderedTemplate)[0] || teddy.findNonLoopedInclude(renderedTemplate)[0]) {

        // parse non-looped conditionals
        renderedTemplate = teddy.parseConditionals(renderedTemplate, model);

        // parse non-looped includes
        renderedTemplate = teddy.parseIncludes(renderedTemplate, model);
      }

      // parse loops and any conditionals or includes within
      renderedTemplate = teddy.parseLoops(renderedTemplate, model);

      // cleans up any remaining unnecessary <elseif>, <elseunless>, or <else> tags
      renderedTemplate = teddy.removeDanglingConditionals(renderedTemplate);

      // processes all remaining {vars}
      renderedTemplate = teddy.parseVars(renderedTemplate, model); // last one converts it to a string

      // remove any unnecessary whitespace generated by <include>s (probably caused by a bug in xmldom)
      renderedTemplate = renderedTemplate.replace(/> </g, '><');

      // rename any elements we temporarily renamed back to their original names
      renderedTemplate = teddy.restoreProblemElements(renderedTemplate);

      // clean up temp vars
      teddy._contextModels = [];
      teddy._baseModel = {};

      // execute callback if present, otherwise simply return the rendered template string
      if ((typeof callback).toLowerCase() === 'function') {
        if (!errors) {
          callback(null, renderedTemplate);
        }
        else {
          callback(errors, renderedTemplate);
        }
      }
      else {
        return renderedTemplate;
      }
    },


    /**
     * Teddy group parsing methods
     */

    // finds all <include> tags and renders them
    parseIncludes: function(doc, model) {
      var el,
          notDone = true,
          result;

      while (notDone) {
        el = teddy.findNonLoopedInclude(doc)[0];
        if (el) {
          notDone = true;
          result = teddy.renderInclude(el, model);
          model = teddy._baseModel; // restore original model
          if (result.newDoc) {
            doc = result;
          }
          else {
            teddy.replaceProcessedElement(el, result);
          }
        }
        else {
          notDone = false;
        }
      }

      return doc;
    },

    // finds all <if> and <unless> tags and renders them along with any related <elseif>, <elseunless>, and <else> tags
    parseConditionals: function(doc, model) {
      var el,
          result,
          conditionals = teddy.findNonLoopedConditionals(doc),      // skips conditionals within <foreach> tags
          oneliners = teddy.findNonLoopedOneLineConditionals(doc),  // ditto
          length,
          i;

      // process whitelisted conditionals
      length = conditionals.length;
      for (i = 0; i < length; i++) {
        el = conditionals[i];
        result = teddy.renderConditional(el, model);
        model = teddy._baseModel; // restore original model
        teddy.replaceProcessedElement(el, result);
      }

      // process whitelisted one-line conditionals
      length = oneliners.length;
      for (i = 0; i < length; i++) {
        el = oneliners[i];
        result = teddy.renderOneLineConditional(el, model);
        model = teddy._baseModel; // restore original model
        if (isNode) {
          teddy.replaceProcessedElement(el, result);
        }
      }

      return doc;
    },

    // finds all <foreach> tags and renders them
    parseLoops: function(doc, model) {
      var el,
          notDone = true,
          result;

      while (notDone) {
        el = doc.getElementsByTagName('foreach')[0];
        if (el) {
          notDone = true;
          result = teddy.renderForeach(el, model);
          model = teddy._baseModel; // restore original model
          teddy.replaceProcessedElement(el, result);
        }
        else {
          notDone = false;
        }
      }

      return doc;
    },

    // removes dangling <elseif>, <elseunless>, and <else> tags as they are no longer needed
    removeDanglingConditionals: function(doc) {
      var notDone = true, el;

      while (notDone) {
        el = doc.getElementsByTagName('elseif')[0] || doc.getElementsByTagName('elseunless')[0] || doc.getElementsByTagName('else')[0];

        if (el) {
          notDone = true;
          el.parentNode.removeChild(el);
        }
        else {
          notDone = false;
        }
      }

      return doc;
    },

    // finds alls {vars} in a given document and replaces them with values from the model
    parseVars: function(doc, model) {
      var docstring = (typeof doc).toLowerCase() === 'string' ? doc : serializer.serializeToString(doc), // not using serializer.serializeToString because this method can be called on a fully formed document and we don't want to exclude the root elements
          curls,
          numCurls,
          curl,
          varname,
          i,
          varList,
          lastVarList,
          iterations = 0,
          curVar,
          dots,
          numDots,
          d,
          doRender;

      docstring = docstring.replace(/%7B/g, '{').replace(/%7D/g, '}'); // hack for gecko

      do {
        lastVarList = varList;
        varList = [];
        curls = docstring ? docstring.split('{') : false;
        numCurls = curls.length;

        if (curls) {
          for (i = 0; i < numCurls; i++) {
            curl = curls[(i + 1)];
            if (curl) {
              varname = curl.split('}')[0].toLowerCase();
              if (varname) {
                varList.push(varname);
                dots = varname.split('.');
                numDots = dots.length;
                curVar = model;
                if (curVar) {
                  doRender = true;
                  for (d = 0; d < numDots; d++) {
                    curVar = curVar[dots[d]];
                    if ((typeof curVar).toLowerCase() === 'undefined') {
                      if (teddy.params.verbosity > 1) {
                        console.warn('a {variable} was found with an invalid syntax: {' + varname + '}');
                      }
                      doRender = false;
                      break;
                    }
                  }
                }
                else {
                  if (teddy.params.verbosity > 1) {
                    console.warn('a {variable} was found with an invalid syntax do to undefined model: {' + varname + '}');
                  }
                  doRender = false;
                  break;
                }
                if (doRender) {
                  docstring = teddy.renderVar(docstring, varname, curVar);
                }
              }
            }
          }
        }
        else {
          if (teddy.params.verbosity > 1 && (typeof doc).toLowerCase() !== 'object') {
            console.warn('teddy.parseVars called with invalid doc specified. Ignoring call.');
            return false;
          }
          else {
            return docstring;
          }
        }

        iterations++;
        if (iterations > 999) {
          console.warn('teddy.parseVars gave up after parsing variables over 999 layers deep. You may have a recursive variable loop.');
          return docstring;
        }
      }
      while (JSON.stringify(varList) !== JSON.stringify(lastVarList));
      return docstring;
    },


    /**
     * Teddy render methods
     */

    // parses a single <include> tag
    renderInclude: function(el, model) {
      var src, incdoc, args, argl, arg, argname, argval, i, newDoc, localModel = {};

      if (el) {
        src = el.getAttribute('src');

        if (!src) {
          if (teddy.params.verbosity) {
            console.warn('<include> element found with no src attribute. Ignoring elment.');
          }
          return false;
        }
        else {

          // parse variables which may be included in src attribute
          src = teddy.parseVars(src, model);

          // append extension if not present
          if (src.slice(-5) !== '.html') {
            src += '.html';
          }

          // compile included template if necessary
          if (!teddy.compiledTemplates[src] || teddy.params.compileAtEveryRender) {
            teddy.compile(src);
          }

          // get the template as a string
          incdoc = teddy.compiledTemplates[src];

          // determine if it's a new document
          newDoc = (incdoc.toLowerCase().indexOf('<!doctype') > -1) ? true : false;

          if (!incdoc) {
            if (teddy.params.verbosity) {
              console.warn('<include> element found which references a nonexistent template ("' + src + '"). Ignoring elment.');
            }
            return false;
          }

          // process arguments
          args = el.childNodes;
          argl = args.length;
          for (i = 0; i < argl; i++) {
            arg = args[i];
            if (arg.nodeName.toLowerCase() !== 'arg' && !arg.getAttribute('data-unknownelementhack')) {
              if (teddy.params.verbosity) {
                console.warn('child element found within a <include src="'+src+'"> that wasn\'t an <arg> element.');
              }
            }
            else {
              argname = arg.attributes[0];
              argval = '';

              if (argname) {
                argname = argname.nodeName.toLowerCase(); // forces case insensitivity
              }
              else {
                if (teddy.params.verbosity) {
                  console.warn('<arg> element found with no attribute. Ignoring parent <include> element. (<include src="'+src+'">)');
                }
                return false;
              }

              // convert arg's children into a string
              argval = teddy.stringifyElementChildren(arg);

              // replace template string argument {var} with argument value
              incdoc = teddy.renderVar(incdoc, argname, argval);

              // add arg to local model
              localModel[argname] = argval;
            }
          }

          // create a dom object out of parsed template string
          incdoc = parser.parseFromString(incdoc, 'text/html');

          if (argl) {
            // apply local model to child conditionals and loops
            incdoc = teddy.tagLocalModels(incdoc, localModel);
          }

          // marks whether or not the included document is a new document or a partial
          incdoc.newDoc = newDoc;

          return incdoc;
        }
      }
      else {
        if (teddy.params.verbosity > 1) {
          console.warn('teddy.renderInclude() called for an <include> element that does not exist.');
        }
        return false;
      }
    },

    // finds all <if>, <elseif>, <unless>, <elseunless>, one line ifs, and <foreach> tags and applies their local models
    tagLocalModels: function(doc, extraModel) {
      var el,
          els = doc.getElementsByTagName('*'),
          length = els.length,
          i,
          modelNumber,
          nodeName;

      modelNumber = teddy._contextModels.push(extraModel);

      for (i = 0; i < length; i++) {
        el = els[i];
        nodeName = el.nodeName.toLowerCase();
        if (el.getAttribute('true') || el.getAttribute('false') || nodeName === 'if' || nodeName === 'elseif' || nodeName === 'unless' || nodeName === 'elseunless' || nodeName === 'foreach') {
          el.setAttribute('data-local-model', modelNumber);
        }
      }

      return doc;
    },

    // retrieve local model from cache and apply it to full model for parsing
    applyLocalModel: function(el, model) {
      var attr = el.getAttribute('data-local-model'),
          modelNumber = ('' + attr).length ? parseInt(attr) : -1,
          localModel = teddy._contextModels[modelNumber - 1],
          i;

      if (localModel) {
        for (i in localModel) {
          model[i] = localModel[i];
        }
      }
      return model;
    },

    // parses a single <foreach> tag
    renderForeach: function(el, model) {
      if (el) {
        var key = el.getAttribute('key'),
            val = el.getAttribute('val'),
            collection = ('' + el.getAttribute('in')).toLowerCase(),
            i,
            loopContent = '',
            parsedLoop = '',
            item,
            newEl;

        if (!val) {
          if (teddy.params.verbosity) {
            console.warn('<foreach> element found with no "val" attribute. Ignoring elment.');
          }
          return false;
        }
        else if (!collection) {
          if (teddy.params.verbosity) {
            console.warn('<foreach> element found with no "in" attribute. Ignoring elment.');
          }
          return false;
        }
        else {
          collection = model[collection];
          if (!collection) {
            if (teddy.params.verbosity) {
              console.warn('<foreach> element found with undefined value specified for "in" attribute. Ignoring elment.');
            }
            return false;
          }
          else {

            // add local vars to model
            model = teddy.applyLocalModel(el, model);

            // tells parseConditionals that this foreach is safe to process conditionals in
            el.setAttribute('looped', 'true');

            loopContent = teddy.stringifyElementChildren(el);

            // process loop
            for (i in collection) {
              item = collection[i];

              // define local model for the iteration
              // if model[val] or model[key] preexist, they will be overwritten by the locally supplied variables
              model[val] = item;
              if (key) {
                model[key] = i;
              }

              parsedLoop += teddy.parseVars(loopContent, model);

              // create a dom object out of parsed template string
              newEl = parser.parseFromString(parsedLoop, 'text/html');

              // since includes can introduce new conditionals, we loop until they're all dealt with
              while (teddy.findNonLoopedConditionals(newEl)[0] || teddy.findNonLoopedOneLineConditionals(newEl)[0] || teddy.findNonLoopedInclude(newEl)[0]) {

                // find conditionals within the loop and process them
                newEl = teddy.parseConditionals(newEl, model);

                // find includes within the loop and process them
                newEl = teddy.parseIncludes(newEl, model);
              }

              // okay, we're done with this iteration. we need to convert it back to a string for the next iteration
              parsedLoop = teddy.stringifyElement(newEl);
            }

            // restore original model
            model = teddy._baseModel;

            return newEl;
          }
        }
      }
      else {
        if (teddy.params.verbosity > 1) {
          console.warn('teddy.renderForeach() called for a <foreach> element that does not exist.');
        }
        return false;
      }
    },

    // parses a single <if> or <unless> tag and any related <elseif>, <elseunless>, and <else> tags
    renderConditional: function(el, model) {
      if (el) {
        var satisfiedCondition = false,
            nextSibling = el,
            nextSiblingName = nextSibling.nodeName.toLowerCase(),
            conditionContent;

        // add local vars to model
        model = teddy.applyLocalModel(el, model);

        while (!satisfiedCondition) {

          // satisfied condition
          if (teddy.evalCondition(el, model)) {
            satisfiedCondition = true;

            // get condition's children and stringify them
            conditionContent = teddy.stringifyElementChildren(el);

            // create a dom object out of that string
            el = parser.parseFromString(conditionContent, 'text/html');

            return el;
          }

          // failed condition, try the next one
          else if (nextSibling) {

            // get next elseif, elseunless, or else statement and evaluate it
            nextSiblingName = nextSibling;
            nextSibling = nextSibling.nextSibling;
            nextSiblingName = nextSibling ? nextSibling.nodeName.toLowerCase() : false;
            while (nextSibling) {
              if (nextSiblingName === 'if' || nextSiblingName === 'unless') {
                satisfiedCondition = true; // none of the conditions were true
                break;
              }
              else if (nextSiblingName === 'elseif' || nextSiblingName === 'elseunless' || nextSiblingName === 'else') {
                el = nextSibling; // advance parent loop
                break;
              }
              else {
                nextSibling = nextSibling.nextSibling;
              }
            }
          }

          // no further siblings; no further conditions to test
          else {

            // restore original model
            model = teddy._baseModel;

            return false;
          }
        }

        // restore original model
        model = teddy._baseModel;
      }
      else {
        if (teddy.params.verbosity > 1) {
          console.warn('teddy.renderConditional() called for a <if> or <unless> element with no condition supplied.');
        }
        return false;
      }
    },

    // parses a single one line conditional
    renderOneLineConditional: function(el, model) {
      if (el) {
        var conditionContent,
            newAttr,
            attrVal;

        // add local vars to model
        model = teddy.applyLocalModel(el, model);
        el.removeAttribute('data-local-model');

        if (teddy.evalCondition(el, model)) {
          conditionContent = el.getAttribute('true');
        }
        else {
          conditionContent = el.getAttribute('false');
        }

        el.removeAttribute('true');
        el.removeAttribute('false');

        newAttr = conditionContent.split('=');
        attrVal = newAttr[1];
        newAttr = newAttr[0];

        if (newAttr) {
          if (attrVal) {
            attrVal = attrVal.replace(/"/g, '').replace(/'/g, '');
            el.setAttribute(newAttr, attrVal);
          }
          else {
            el.setAttribute(newAttr, '');
          }
        }

        // restore original model
        model = teddy._baseModel;

        return el;
      }
      else {
        if (teddy.params.verbosity > 1) {
          console.warn('teddy.renderOneLineConditional() called for an if attribtue with no condition supplied.');
        }
        return false;
      }
    },

    // determines if a condition is true for <if>, <unless>, <elseif>, and <elseunless>, and one-liners
    evalCondition: function(el, model) {

      // some browsers annoyingly add an xmlns attribtue to pretty much everything when parsing HTML through DOMParser's parseFromString method. since xmlns attributes mess up the syntax for Teddy conditionals, we have to remove any xmlns attributes present before evaluating the condtional
      el.removeAttribute('xmlns');

      // also have to remove data-local-model due to a Firefox bug
      el.removeAttribute('data-local-model');

      var conditionType = el.nodeName.toLowerCase(),
          attrCount = 0,
          conditionAttr,
          attributes = el.attributes,
          length = attributes.length,
          i,
          condition,
          conditionVal,
          modelVal,
          curVar,
          dots,
          numDots,
          d,
          notDone = true,
          condResult,
          truthStack = [],
          evalStatement = function() {
            if (!condition) {
              condition = conditionAttr.nodeName.toLowerCase();
            }

            if (condition === 'or' || condition === 'and' || condition === 'xor') {
              return condition; // this is a logical operator, not a condition to evaluate
            }

            if (conditionVal === undefined) {
              conditionVal = teddy.parseVars(conditionAttr.value.trim(), model);
            }

            dots = condition.split('.');
            numDots = dots.length;
            curVar = model;
            if (curVar) {
              for (d = 0; d < numDots; d++) {
                curVar = curVar[dots[d]];
              }
            }
            else {
              if (teddy.params.verbosity > 1) {
                console.warn('teddy.evalCondition() supplied an empty model');
              }
              return false;
            }
            modelVal = curVar;

            if (conditionType === 'if' || conditionType === 'onelineif' || conditionType === 'elseif') {
              if (condition === conditionVal.toLowerCase() || conditionVal === '' || (conditionType === 'onelineif' && 'if-' + condition === conditionVal.toLowerCase())) {
                if (modelVal) {
                  return condition.substr(0, 3) === 'not:' ? false : true;
                }
                else {
                  return condition.substr(0, 3) === 'not:' ? true : false;
                }
              }
              else if (modelVal == conditionVal) {
                return condition.substr(0, 3) === 'not:' ? false : true;
              }
              else {
                return condition.substr(0, 3) === 'not:' ? true : false;
              }
            }
            else {
              if (condition === conditionVal.toLowerCase() || conditionVal === '') {
                if (modelVal) {
                  return condition.substr(0, 3) === 'not:' ? true : false;
                }
                else {
                  return condition.substr(0, 3) === 'not:' ? false : true;
                }
              }
              else if (modelVal != conditionVal) {
                return condition.substr(0, 3) === 'not:' ? false : true;
              }
              else {
                return condition.substr(0, 3) === 'not:' ? true : false;
              }
            }
          };

      if (conditionType === 'else') {
        return true;
      }
      else if (conditionType !== 'if' && conditionType !== 'unless' && conditionType !== 'elseif' && conditionType !== 'elseunless') {
        // it's a one-liner
        conditionType = 'onelineif';
        for (i = 0; i < length; i++) {
          conditionAttr = attributes[i];
          condition = conditionAttr.nodeName;
          if (condition.substr(0, 3) === 'if-') {
            conditionVal = teddy.parseVars(conditionAttr.value, model);
            el.removeAttribute(condition); // so there's no attempt to parse it later
            condition = condition.split('if-')[1].toLowerCase();
            break;
          }
        }
        conditionAttr = el.attributes[attrCount];
        return evalStatement();
      }

      // regular conditional, could be multipart
      do {

        // examine each of the condition attributes
        conditionAttr = el.attributes[attrCount];
        if (conditionAttr) {
          condition = undefined;
          conditionVal = undefined;
          truthStack.push(evalStatement());
          attrCount++;
          if (reordersAttributes) {
            console.warn('teddy.evalCondition() does not support boolean logic in this browser. See https://github.com/kethinov/teddy/issues/23');
            notDone = false;
          }
        }
        else {
          notDone = false;
          length = truthStack.length;
        }
      }
      while (notDone);

      // loop through the results
      for (i = 0; i < length; i++) {
        condition = truthStack[i];
        condResult = condResult !== undefined ? condResult : truthStack[i - 1];
        if (condition === 'and') {
          condResult = Boolean(condResult && truthStack[i + 1]);
        }
        else if (condition === 'or') {
          condResult = Boolean(condResult || truthStack[i + 1]);
        }
        else if (condition === 'xor') {
          condResult = Boolean((condResult && !truthStack[i + 1]) || (!condResult && truthStack[i + 1]));
        }
      }

      return condResult !== undefined ? condResult : condition;
    },

    // replaces a single {var} with its value from a given model
    renderVar: function(str, varname, varval) {
      if (str) {
        // hack to typecast to string
        varname = '' + varname;
        varval = '' + varval;
        return str.replace(new RegExp('{'+varname+'}', 'gi'), varval);
      }
      else {
        if (teddy.params.verbosity > 1) {
          console.warn('an empty string was passed to teddy.renderVar.');
        }
      }
    },

    // finds an <include> tag that is not within any <foreach> tag
    findNonLoopedInclude: function(doc) {
      var el,
          parent,
          includes = [],
          tags = doc.getElementsByTagName('include'),
          length = tags.length,
          skip = false,
          i;

      for (i = 0; i < length; i++) {
        el = tags[i];
        parent = el ? el.parentNode : false;
        while (parent && !skip) {
          if (parent.nodeName) {
            if (parent.nodeName.toLowerCase() === 'foreach') {
              if (!parent.getAttribute('looped')) {
                skip = true;
              }
            }
          }
          parent = parent.parentNode;
        }
        if (el && !skip) {
          includes.push(el);
          return includes;
        }
        else {
          skip = false;
        }
      }

      return includes;
    },

    // finds all <if> and <unless> tags that are not within any <foreach> tags
    findNonLoopedConditionals: function(doc) {
      var el,
          parent,
          notDone = true,
          conditionals = [],
          ifs = doc.getElementsByTagName('if'),
          length = ifs.length,
          unlesses = false,
          skip = false,
          i;

      while (notDone) {
        for (i = 0; i < length; i++) {
          el = ifs[i];
          parent = el ? el.parentNode : false;
          while (parent && !skip) {
            if (parent.nodeName) {
              if (parent.nodeName.toLowerCase() === 'foreach') {
                if (!parent.getAttribute('looped')) { // exemption check
                  skip = true;
                }
              }
            }
            parent = parent.parentNode;
          }
          if (el && !skip) {
            conditionals.push(el);
          }
          else {
            skip = false;
          }
        }

        // we're done with <if>s, so do <unless>es if necessary
        if (!unlesses) {
          // set it to unlesses for one more pass
          ifs = doc.getElementsByTagName('unless');
          length = ifs.length;
          unlesses = true;
        }
        else {
          notDone = false; // we're done, break loop
        }
      }

      return conditionals;
    },

    // finds all one line conditionals that are not within any <foreach> tags
    findNonLoopedOneLineConditionals: function(doc) {
      var el,
          parent,
          conditionals = [],
          ifs = doc.getElementsByTagName('*'),
          length = ifs.length,
          skip = false,
          i;

      for (i = 0; i < length; i++) {
        el = ifs[i];
        parent = el ? el.parentNode : false;
        if (!el.getAttribute('true') && !el.getAttribute('false')) {
          skip = true;
        }
        while (parent && !skip) {
          if (parent.nodeName) {
            if (parent.nodeName.toLowerCase() === 'foreach') {
              if (!parent.getAttribute('looped')) { // exemption check
                skip = true;
              }
            }
          }
          parent = parent.parentNode;
        }
        if (el && !skip) {
          conditionals.push(el);
        }
        else {
          skip = false;
        }
      }

      return conditionals;
    },


    /**
     * Utility methods
     */

    // normalizes XMLSerializer's serializeToString method (fixes some browser compatibility issues)
    stringifyElement: function(el) {
      var innerHTML = false, body = el.body;

      // try innerHTML
      if (body) {
        innerHTML = body.innerHTML;
        if (innerHTML) {
          return innerHTML;
        }
      }

      // innerHTML failed, so just return the standard serializer
      return serializer.serializeToString(el);
    },

    // converts all of a DOM node's children into a single string
    stringifyElementChildren: function(el) {
      if (el) {
        var childNodes = el.childNodes, i, child, childString = '';

        for (i in childNodes) {
          child = childNodes[i];
          if ((typeof child).toLowerCase() === 'object') {
            childString += teddy.stringifyElement(child);
          }
        }

        return childString;
      }
      else {
        if (teddy.params.verbosity > 1) {
          console.warn('teddy.stringifyElementChildren called on a non-DOM object');
        }
        return false;
      }
    },

    // makes a JSON structure's keys all lower case (all variables in Teddy templates are case-insensitive because HTML is case-insensitive)
    flattenModel: function(model) {
      var newModel = {}, i, item;

      // sanity check for circular data
      try {
        JSON.stringify(model);
      }
      catch (e) {
        if (e === 'TypeError: Converting circular structure to JSON') {
          console.error(e);
          console.error('do not pass data models to Teddy that have a circular structure.');
        }
        return newModel;
      }

      for (i in model) {
        item = model[i];
        if ((typeof item).toLowerCase() === 'object') {
          item = teddy.flattenModel(item);
        }
        newModel[i.toLowerCase()] = item;
      }
      return newModel;
    },

    // replaces 'el' with 'result'
    replaceProcessedElement: function(el, result) {
      if (!el) {
        if (teddy.params.verbosity > 1) {
          console.warn('teddy.replaceProcessedElement called without being supplied a valid element to replace');
        }
        return false;
      }

      var parent = el.parentNode, sibling = el.nextSibling, i, children, length, child, clone;

      if (parent) {
        parent.removeChild(el);
      }
      else {
        if (teddy.params.verbosity > 1) {
          console.warn('teddy.replaceProcessedElement called on an object without a parentNode');
        }
        return false;
      }

      if (result) {
        if (isNode) {
          if (sibling) {
            parent.insertBefore(result, sibling);
          }
          else {
            parent.appendChild(result);
          }
        }
        else {
          result = result.body;
          children = result.childNodes;
          length = children.length;
          for (i = 0; i < length; i++) {
            child = children[i];
            if ((typeof child).toLowerCase() === 'object') {
              clone = child.cloneNode(true);
              if (sibling) {
                parent.insertBefore(clone, sibling);
              }
              else {
                parent.appendChild(clone);
              }
            }
          }
        }
      }
      else {
        if (teddy.params.verbosity > 1) {
          console.warn('teddy.replaceProcessedElement called without being supplied a result');
        }
        return false;
      }
    },

    temporarilyRenameProblemElements: function(docString) {
      var problemElements = teddy._problemElements, i, l = problemElements.length, el;

      for (i = 0; i < l; i++) {
        el = problemElements[i];
        docString = docString
        .replace(new RegExp('<' + el + ' ', 'gi'), '<teddy-' + el + ' ')
        .replace(new RegExp('<' + el + '>', 'gi'), '<teddy-' + el + '>')
        .replace(new RegExp('</' + el + '>', 'gi'), '</teddy-' + el + '>');
      }

      return docString;
    },

    restoreProblemElements: function(docString) {
      var problemElements = teddy._problemElements, i, l = problemElements.length, el;

      for (i = 0; i < l; i++) {
        el = problemElements[i];
        docString = docString
        .replace(new RegExp('<teddy-' + el + ' ', 'gi'), '<' + el + ' ')
        .replace(new RegExp('<teddy-' + el + '>', 'gi'), '<' + el + '>')
        .replace(new RegExp('</teddy-' + el + '>', 'gi'), '</' + el + '>');
      }

      return docString;
    },

    // hack to work around Opera and MSIE bug in which DOMParser's parseFromString method incorrectly parses empty UnknownElements. Since <include> tags can sometimes not have children, this hack is necessary for Opera and IE compatibility.
    runUnknownElementParentSiblingHack: function(doc) {
      if (!isNode) {
        var includes, inlength, i, el, hack, hasBug = parser.parseFromString(serializer.serializeToString(parser.parseFromString('<z></z><p></p>', 'text/html')), 'text/html').getElementsByTagName('z')[0].firstChild;

        if (hasBug) {
          includes = doc.body.getElementsByTagName('include');
          inlength = includes.length;
          for (i = 0; i < inlength; i++) {
            el = includes[i];
            if (!el.firstChild) {
              hack = document.createElement('p');
              hack.setAttribute('data-unknownelementhack', 'true');
              hack.setAttribute('hidden', 'hidden');
              hack.setAttribute('style', 'display:none');
              hack.innerHTML = 'h';
              el.appendChild(hack);
            }
          }
        }
      }
      return doc;
    },


    /**
     * Error handler methods
     */

    // suppresses xml warnings (because Teddy is a made-up HTML syntax)
    DOMParserWarningHandler: function(e) {
      if (teddy.params.verbosity > 2) {
        console.warn('Teddy\'s DOMParser issued the following warning:');
        console.warn(e);
      }
    },

    // logs xml errors
    DOMParserErrorHandler: function(e) {
      if (teddy.params.verbosity) {
        console.warn('Teddy\'s DOMParser issued the following warning:');
        console.warn(e);
      }
    },

    // fatal errors
    DOMParserFatalErrorHandler: function(e) {
      if (teddy.params.strictParser) {
        console.error('Teddy\'s DOMParser experienced a fatal error:');
        throw e;
      }
      else {
        console.error('Teddy\'s DOMParser experienced a fatal error:');
        console.error(e);
      }
    },

    // logs file I/O errors in node.js
    readFileError: function(e) {
      if (teddy.params.verbosity) {
        console.warn('teddy.compile attempting to compile a template which doesn\'t exist: ' + e);
      }
    },


    /**
     * Teddy object public member vars
     */

    // compiled templates are stored as object collections, e.g. { "myTemplate.html": "<p>some markup</p>"}
    compiledTemplates: {},

    // packaged templates are stored as raw JS statements that can be sent to the client and eval'd, e.g. "teddy.compiledTemplates['myTemplate.html']='<p>some markup</p>';"
    packagedTemplates: {},

    // default values for parameters sent to teddy
    params: {
      verbosity: 1,
      templateRoot: './',
      strictParser: false,
      compileAtEveryRender: false
    },

    // stores local models for later consumption by template logic tags
    _contextModels: [],

    // list of elements to temporarily rename during parsing
    _problemElements: [
      // table elements are problematic because they whitelist allowable child elements
      'table', 'caption', 'colgroup', 'col', 'thead', 'tfoot', 'tbody', 'tr', 'th', 'td',

      // text node-only elements are problematic because they don't permit child elements
      'script', 'textarea', 'title',

      // <option> is a text node-only element and <select> / <datalist> only permits certain child elements
      'select', 'datalist', 'option', 'optgroup'
    ],

    /**
     * Mutator methods for Teddy object public member vars
     */

    // mutator method to set verbosity param. takes human-readable string argument and converts it to an integer for more efficient checks against the setting
    setVerbosity: function(v) {
      switch (v) {
        case 'none':
          v = 0;
          break;
        case 'verbose':
          v = 2;
          break;
        case 'DEBUG':
          v = 3;
          break;
        default: // case 'concise':
          v = 1;
      }
      teddy.params.verbosity = v;
    },

    // mutator method to set template root param; must be a string
    setTemplateRoot: function(v) {
      teddy.params.templateRoot = String(v);
    },

    // turn on or off the setting to throw an exception if the template is not well formed
    strictParser: function(v) {
      teddy.params.strictParser = Boolean(v);
    },

    // turn on or off the setting to compile templates at every render
    compileAtEveryRender: function(v) {
      teddy.params.compileAtEveryRender = Boolean(v);
    }
  },

  // private utility vars
  isNode = ((typeof module).toLowerCase() !== 'undefined' && module.exports) ? true : false,
  fs,
  path,
  xmldom,
  parser,
  serializer,
  oldIE,
  reordersAttributes;

  // set env specific vars for node.js
  if (isNode) {
    module.exports = teddy; // makes teddy requirable in node.js
    module.exports.__express = teddy.render; // express.js support

    // node module dependencies
    fs = require('fs');
    path = require('path');
    xmldom = require('xmldom');

    // define parser and serializer from xmldom
    parser = new xmldom.DOMParser({
      errorHandler: {
        warning: teddy.DOMParserWarningHandler,
        error: teddy.DOMParserErrorHandler,
        fatalError: teddy.DOMParserFatalErrorHandler
      }
    });
    serializer = new xmldom.XMLSerializer();
  }

  // set env specific vars for client-side
  else {
    global.teddy = teddy;

    // test for old IE
    oldIE = document.createElement('p');
    oldIE.innerHTML = '<!--[if lte IE 9]><i></i><![endif]-->';
    oldIE = oldIE.getElementsByTagName('i').length === 1 ? true : false;

    if (!oldIE) {
      // IE does not populate console unless the developer tools are opened
      if (typeof console === 'undefined') {
        window.console = {};
        console.log = console.warn = console.error = function() {};
      }

      parser = new DOMParser();
      serializer = new XMLSerializer();

      /*
       * DOMParser HTML extension
       * 2012-09-04
       *
       * By Eli Grey, http://eligrey.com
       * Modified for use in Teddy by Eric Newport (kethinov)
       * Public domain.
       * NO WARRANTY EXPRESSED OR IMPLIED. USE AT YOUR OWN RISK.
       *
       * @source https://gist.github.com/kethinov/4760460
       */

      (function(DOMParser) {
        var DOMParserProto = DOMParser.prototype,
            realParseFromString = DOMParserProto.parseFromString;

        // Firefox/Opera/IE throw errors on unsupported types
        try {
          // WebKit returns null on unsupported types
          if ((new DOMParser()).parseFromString("", "text/html")) {
            // text/html parsing is natively supported
            return;
          }
        }
        catch (ex) {}

        DOMParserProto.parseFromString = function(markup, type) {
          if (/^\s*text\/html\s*(?:;|$)/i.test(type)) {
            var doc = document.implementation.createHTMLDocument('');
            if (markup.toLowerCase().indexOf('<!doctype') > -1) {
              doc.documentElement.innerHTML = markup;
            }
            else {
              doc.body.innerHTML = markup;
            }
            return doc;
          }
          else {
            return realParseFromString.apply(this, arguments);
          }
        };
      }(DOMParser));

      // test to see if the browser reorders attributes (e.g. IE)
      reordersAttributes = parser.parseFromString(serializer.serializeToString(parser.parseFromString('<if o t>', 'text/html')), 'text/html').getElementsByTagName('if')[0].attributes[0].nodeName === 't';
    }
  }
})(this);